defmodule ChainAutomation.Execution.Secrets do
  @moduledoc """
  Reads the secrets an attempt needs from `chain.automation_secrets_v1` and opens them (automation.md §8.1 step 3;
  automation-contract.md §7). Each one must exist, allow the request's destination, and travel over `http` only when the
  destination confirms it. The values live in memory for this attempt only.
  """

  alias ChainAutomation.Contract.{Keks, SecretEnvelope, WorkRequest}
  alias ChainAutomation.Repo

  @type result :: {:ok, %{String.t() => String.t()}} | {:error, atom(), String.t()}

  @doc "The values by name, or the first refusal; and the versions read, for the attempt's summary."
  @spec read(WorkRequest.t(), Keks.t()) :: {result(), %{String.t() => pos_integer()}}
  def read(%WorkRequest{secrets: []}, _keks), do: {{:ok, %{}}, %{}}

  def read(%WorkRequest{} = work, keks) do
    rows =
      ("SELECT name, version, ciphertext, nonce, wrapped_data_key, key_id, allowed_destinations " <>
         "FROM chain.automation_secrets_v1 WHERE name = ANY($1)")
      |> Repo.query!([work.secrets])
      |> Map.fetch!(:rows)
      |> Map.new(fn [name | _] = row -> {name, row} end)

    versions = Map.new(rows, fn {name, [_name, version | _]} -> {name, version} end)

    result =
      Enum.reduce_while(work.secrets, {:ok, %{}}, fn name, {:ok, values} ->
        case open(rows[name], name, work.destination, keks) do
          {:ok, value} -> {:cont, {:ok, Map.put(values, name, value)}}
          refusal -> {:halt, refusal}
        end
      end)

    {result, versions}
  end

  defp open(nil, name, _destination, _keks),
    do: {:error, :secret_missing, "The secret '#{name}' does not exist."}

  defp open([_, version, ciphertext, nonce, wrapped, key_id, allowed], name, destination, keks) do
    cond do
      destination.name not in allowed ->
        {:error, :secret_not_allowed,
         "The secret '#{name}' is not allowed for the destination '#{destination.name}'."}

      destination.scheme == "http" and not destination.allow_secrets_over_http ->
        {:error, :secret_not_allowed,
         "The secret '#{name}' cannot travel over http to '#{destination.name}' without allowSecretsOverHttp."}

      true ->
        row = %{
          name: name,
          version: version,
          key_id: key_id,
          nonce: nonce,
          ciphertext: ciphertext,
          wrapped_data_key: wrapped
        }

        case SecretEnvelope.decrypt(row, keks) do
          {:ok, value} ->
            {:ok, value}

          {:error, :unknown_key} ->
            {:error, :internal_error,
             "The secret '#{name}' cannot be decrypted: its KEK '#{key_id}' is not configured."}

          {:error, :undecryptable} ->
            {:error, :internal_error, "The secret '#{name}' cannot be decrypted."}
        end
    end
  end
end
