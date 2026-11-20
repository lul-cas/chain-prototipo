defmodule ChainAutomation.Contract.SecretEnvelopeTest do
  use ExUnit.Case, async: true

  alias ChainAutomation.Contract.{Keks, SecretEnvelope}
  alias ChainAutomation.{ChainViews, ContractFixture}

  setup do
    vector = ContractFixture.read!("secret-envelope.json")
    expected = vector["expected"]
    {:ok, keks} = Keks.parse(vector["keks"])

    row = %{
      name: vector["name"],
      version: vector["version"],
      key_id: expected["key_id"],
      nonce: Base.decode64!(expected["nonce"]),
      ciphertext: Base.decode64!(expected["ciphertext"]),
      wrapped_data_key: Base.decode64!(expected["wrapped_data_key"])
    }

    %{vector: vector, keks: keks, row: row}
  end

  test "the shared vector decrypts back to its value", %{vector: vector, keks: keks, row: row} do
    assert SecretEnvelope.decrypt(row, keks) == {:ok, vector["value"]}
  end

  test "a row copied to another name or version, or with any byte changed, does not decrypt", %{
    keks: keks,
    row: row
  } do
    for changed <- [
          %{row | name: "outro_segredo"},
          %{row | version: row.version + 1},
          %{row | ciphertext: flip(row.ciphertext)},
          %{row | nonce: flip(row.nonce)},
          %{row | wrapped_data_key: flip(row.wrapped_data_key)},
          %{
            row
            | wrapped_data_key: flip(row.wrapped_data_key, byte_size(row.wrapped_data_key) - 1)
          }
        ] do
      assert SecretEnvelope.decrypt(changed, keks) == {:error, :undecryptable}
    end
  end

  test "the data key is bound to the KEK id that wrapped it", %{vector: vector, row: row} do
    [_id, key] = String.split(vector["keks"], ":", parts: 2)
    {:ok, renamed} = Keks.parse("dev2:#{key}")

    assert SecretEnvelope.decrypt(%{row | key_id: "dev2"}, renamed) == {:error, :undecryptable}
  end

  test "a KEK id that is not configured", %{row: row} do
    {:ok, other} = Keks.parse("dev9:#{Base.encode64(:binary.copy(<<1>>, 32))}")

    assert SecretEnvelope.decrypt(row, other) == {:error, :unknown_key}
  end

  test "columns of the wrong length", %{keks: keks, row: row} do
    for changed <- [
          %{row | nonce: binary_part(row.nonce, 0, 11)},
          %{row | nonce: <<>>},
          %{row | ciphertext: binary_part(row.ciphertext, 0, 15)},
          %{row | wrapped_data_key: binary_part(row.wrapped_data_key, 0, 59)}
        ] do
      assert SecretEnvelope.decrypt(changed, keks) == {:error, :undecryptable}
    end
  end

  test "a value that is not UTF-8 does not open", %{vector: vector, keks: keks} do
    {:ok, kek} = Keks.fetch(keks, vector["activeKek"])
    row = ChainViews.seal(kek, vector["activeKek"], "erp_api_key", 3, <<0xFF, 0xFE>>)

    assert SecretEnvelope.decrypt(row, keks) == {:error, :undecryptable}

    assert {:ok, "ok"} ==
             SecretEnvelope.decrypt(
               ChainViews.seal(kek, vector["activeKek"], "erp_api_key", 3, "ok"),
               keks
             )
  end

  describe "the secret re-wrapped under a second KEK (secret-envelope-rewrapped.json; ADR-0017 §5.7)" do
    setup do
      moved = ContractFixture.read!("secret-envelope-rewrapped.json")
      expected = moved["expected"]
      [old, new] = String.split(moved["keks"], ",")

      row = %{
        name: moved["name"],
        version: moved["version"],
        key_id: expected["key_id"],
        nonce: Base.decode64!(expected["nonce"]),
        ciphertext: Base.decode64!(expected["ciphertext"]),
        wrapped_data_key: Base.decode64!(expected["wrapped_data_key"])
      }

      %{moved: moved, moved_row: row, old_kek: old, new_kek: new}
    end

    test "a ring of both keys opens the secret before and after the move", context do
      {:ok, both} = Keks.parse(context.moved["keks"])

      assert SecretEnvelope.decrypt(context.row, both) == {:ok, context.vector["value"]}
      assert SecretEnvelope.decrypt(context.moved_row, both) == {:ok, context.moved["value"]}
    end

    test "after the move the new key alone opens it, and the old key alone gives :unknown_key",
         context do
      {:ok, new_only} = Keks.parse(context.new_kek)
      {:ok, old_only} = Keks.parse(context.old_kek)

      assert SecretEnvelope.decrypt(context.moved_row, new_only) == {:ok, context.moved["value"]}
      assert SecretEnvelope.decrypt(context.moved_row, old_only) == {:error, :unknown_key}
    end

    test "only the wrapping moved: the value's nonce and ciphertext are the first vector's",
         context do
      assert {context.moved_row.nonce, context.moved_row.ciphertext} ==
               {context.row.nonce, context.row.ciphertext}

      assert {context.moved["name"], context.moved["version"]} ==
               {context.vector["name"], context.vector["version"]}

      refute context.moved_row.wrapped_data_key == context.row.wrapped_data_key
    end
  end

  defp flip(bytes, at \\ 0) do
    <<before::binary-size(^at), byte, rest::binary>> = bytes
    <<before::binary, Bitwise.bxor(byte, 1), rest::binary>>
  end
end
