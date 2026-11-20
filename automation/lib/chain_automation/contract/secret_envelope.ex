defmodule ChainAutomation.Contract.SecretEnvelope do
  @moduledoc """
  Opens a secret stored by .NET (automation-contract.md §5; ADR-0012 Part 1 §2): the KEK unwraps the data key, and the data
  key decrypts the value, both with AES-256-GCM. The associated data binds the name, the version and the KEK id, so a row
  copied to another name or version does not decrypt. The value lives in memory for one attempt only.
  """

  alias ChainAutomation.Contract.Keks

  @nonce_size 12
  @tag_size 16
  @key_size 32

  @type row :: %{
          name: String.t(),
          version: pos_integer(),
          key_id: String.t(),
          nonce: binary(),
          ciphertext: binary(),
          wrapped_data_key: binary()
        }

  @doc "The value, `:unknown_key` when the row's KEK is not configured, or `:undecryptable` for anything else."
  @spec decrypt(row(), Keks.t()) :: {:ok, String.t()} | {:error, :unknown_key | :undecryptable}
  def decrypt(row, keks) do
    with {:ok, kek} <- fetch_kek(keks, row.key_id),
         <<wrap_nonce::binary-size(@nonce_size), wrapped::binary-size(@key_size),
           wrap_tag::binary-size(@tag_size)>> <-
           row.wrapped_data_key,
         {:ok, data_key} <-
           open(
             kek,
             wrap_nonce,
             wrapped,
             wrap_tag,
             "chain.dek.v1|#{row.key_id}|#{row.name}|#{row.version}"
           ),
         true <- byte_size(row.nonce) == @nonce_size and byte_size(row.ciphertext) >= @tag_size,
         size = byte_size(row.ciphertext) - @tag_size,
         <<ciphertext::binary-size(^size), tag::binary>> = row.ciphertext,
         {:ok, value} <-
           open(
             data_key,
             row.nonce,
             ciphertext,
             tag,
             "chain.secret.v1|#{row.name}|#{row.version}"
           ),
         true <- String.valid?(value) do
      {:ok, value}
    else
      {:error, :unknown_key} -> {:error, :unknown_key}
      _ -> {:error, :undecryptable}
    end
  end

  defp fetch_kek(keks, id) do
    case Keks.fetch(keks, id) do
      {:ok, kek} -> {:ok, kek}
      :error -> {:error, :unknown_key}
    end
  end

  defp open(key, nonce, ciphertext, tag, aad) do
    case :crypto.crypto_one_time_aead(:aes_256_gcm, key, nonce, ciphertext, aad, tag, false) do
      plaintext when is_binary(plaintext) -> {:ok, plaintext}
      :error -> :error
    end
  end
end
