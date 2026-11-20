defmodule ChainAutomation.Contract.KeksTest do
  # load!/1 replaces the ring every attempt reads, so these tests do not run alongside others.
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias ChainAutomation.Contract.Keks
  alias ChainAutomation.ContractFixture

  @raw :binary.copy(<<7>>, 32)
  @key Base.encode64(@raw)

  test "entries are read as .NET reads them: split on commas, empty ones skipped, spaces around each trimmed" do
    assert {:ok, keks} =
             Keks.parse(" dev1:#{@key} ,, old_2:#{Base.encode64(:binary.copy(<<9>>, 32))}")

    assert Keks.ids(keks) == ["dev1", "old_2"]
    assert Keks.fetch(keks, "dev1") == {:ok, @raw}
    assert Keks.fetch(keks, "other") == :error
  end

  test "no configuration is an empty ring, since Elixir never writes a secret" do
    for config <- [nil, "", " , "] do
      assert {:ok, keks} = Keks.parse(config)
      assert Keks.ids(keks) == []
    end
  end

  test "a malformed configuration is refused with a message that never shows key material" do
    format = "Each KEK is 'id:base64key' with an id of [a-z0-9_-]{1,32}."

    for {config, message} <- [
          {"dev1", format},
          {"Dev1:#{@key}", format},
          {"dev1\n:#{@key}", format},
          {":#{@key}", format},
          {"#{String.duplicate("a", 33)}:#{@key}", format},
          {"dev1:not base64!", "KEK 'dev1' is not valid base64."},
          {"dev1:#{Base.encode64(<<1, 2, 3>>)}", "KEK 'dev1' must be exactly 32 bytes."},
          {"dev1:#{@key},dev1:#{@key}", "KEK 'dev1' is configured twice."}
        ] do
      assert Keks.parse(config) == {:error, message}, config
    end
  end

  test "load! keeps a valid ring for the attempts and raises on a malformed one, which stops the application" do
    on_exit(fn -> Keks.load!(nil) end)

    assert :ok = Keks.load!("dev1:#{@key}")
    assert Keks.ids(Keks.current()) == ["dev1"]

    assert_raise ArgumentError, "KEK 'dev1' is not valid base64.", fn ->
      Keks.load!("dev1:???")
    end

    assert Keks.ids(Keks.current()) == ["dev1"]
  end

  test "inspecting a ring shows its ids only" do
    {:ok, keks} = Keks.parse("dev1:#{@key}")

    refute inspect(keks) =~ @key

    refute inspect(keks, limit: :infinity, binaries: :as_binaries) =~
             inspect(@raw, binaries: :as_binaries)

    assert inspect(keks) =~ "dev1"
  end

  test "each key's check value is the shared vector's (ADR-0017 §4.3)" do
    vector = ContractFixture.read!("secret-envelope-rewrapped.json")
    {:ok, keks} = Keks.parse(vector["keks"])

    assert map_size(vector["kcv"]) == 2

    for {id, kcv} <- vector["kcv"] do
      {:ok, key} = Keks.fetch(keks, id)
      assert Keks.check_value(key) == kcv
    end
  end

  test "the startup line names each key with its check value, never its material (ADR-0017 §5.2)" do
    vector = ContractFixture.read!("secret-envelope-rewrapped.json")
    Logger.configure(level: :info)

    on_exit(fn ->
      Logger.configure(level: :warning)
      Keks.load!(nil)
    end)

    reversed = vector["keks"] |> String.split(",") |> Enum.reverse() |> Enum.join(",")
    log = capture_log([level: :info], fn -> Keks.load!(reversed) end)

    assert log =~ "Automation KEKs: dev1 (check d43f7334d1e7df4c), dev2 (check 1a40b41e8fa3b9ed)."

    for entry <- String.split(vector["keks"], ",") do
      [_id, material] = String.split(entry, ":", parts: 2)
      refute log =~ material
      refute log =~ inspect(Base.decode64!(material), binaries: :as_binaries)
    end

    assert capture_log([level: :info], fn -> Keks.load!(nil) end) =~ "Automation KEKs: none."
  end
end
