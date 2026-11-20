defmodule ChainAutomation.Contract.Keks do
  @moduledoc """
  The key-encryption keys from `CHAIN_AUTOMATION_KEKS` (automation-contract.md §5): `id:base64key[,id:base64key…]`, read with
  the same rules as .NET's `KeyRing`. Elixir only decrypts, so it needs no active key. Errors, `inspect/1` and the startup
  line never show key material: the line names each key by id and check value (ADR-0017 §5.2).
  """

  require Logger

  @derive {Inspect, only: [:ids]}
  defstruct ids: [], keys: %{}

  @type t :: %__MODULE__{ids: [String.t()], keys: %{String.t() => binary()}}

  @key_size 32
  @check_label "chain.kek-check.v1"
  @format "Each KEK is 'id:base64key' with an id of [a-z0-9_-]{1,32}."

  @spec parse(String.t() | nil) :: {:ok, t()} | {:error, String.t()}
  def parse(config) do
    (config || "")
    |> String.split(",")
    |> Enum.map(&String.trim/1)
    |> Enum.reject(&(&1 == ""))
    |> Enum.reduce_while({:ok, %__MODULE__{}}, fn entry, {:ok, keks} ->
      case add(keks, entry) do
        {:ok, keks} -> {:cont, {:ok, keks}}
        error -> {:halt, error}
      end
    end)
  end

  @doc """
  Parses the configuration, keeps it for the attempts and logs its ids with their check values; a malformed one raises, which
  stops the application.
  """
  @spec load!(String.t() | nil) :: :ok
  def load!(config) do
    case parse(config) do
      {:ok, keks} ->
        :persistent_term.put(__MODULE__, keks)
        Logger.info("Automation KEKs: #{summary(keks)}.")

      {:error, message} ->
        raise ArgumentError, message
    end
  end

  @doc """
  The key check value (ADR-0017 §4.3): the first 8 bytes of HMAC-SHA256 over `chain.kek-check.v1`, keyed with the KEK, as
  16 lowercase hex digits. Both services show it, so an operator can confirm they hold the same material under the same id.
  """
  @spec check_value(binary()) :: String.t()
  def check_value(key),
    do:
      :crypto.mac(:hmac, :sha256, key, @check_label)
      |> binary_part(0, 8)
      |> Base.encode16(case: :lower)

  @doc "The ids in order, each with its check value, as the API's startup line lists them: `k1 (check …), k2 (check …)`."
  @spec summary(t()) :: String.t()
  def summary(%__MODULE__{ids: []}), do: "none"

  def summary(%__MODULE__{ids: ids, keys: keys}),
    do:
      ids
      |> Enum.sort()
      |> Enum.map_join(", ", &"#{&1} (check #{check_value(Map.fetch!(keys, &1))})")

  @doc "The ring kept by `load!/1`; empty before it runs."
  @spec current() :: t()
  def current, do: :persistent_term.get(__MODULE__, %__MODULE__{})

  @spec ids(t()) :: [String.t()]
  def ids(%__MODULE__{ids: ids}), do: ids

  @spec fetch(t(), String.t()) :: {:ok, binary()} | :error
  def fetch(%__MODULE__{keys: keys}, id), do: Map.fetch(keys, id)

  defp add(keks, entry) do
    with [id, encoded] <- String.split(entry, ":", parts: 2),
         true <- Regex.match?(~r/\A[a-z0-9_-]{1,32}\z/, id) do
      add(keks, id, Base.decode64(encoded))
    else
      _ -> {:error, @format}
    end
  end

  defp add(_keks, id, :error), do: {:error, "KEK '#{id}' is not valid base64."}

  defp add(_keks, id, {:ok, key}) when byte_size(key) != @key_size,
    do: {:error, "KEK '#{id}' must be exactly #{@key_size} bytes."}

  defp add(%{keys: keys}, id, _) when is_map_key(keys, id),
    do: {:error, "KEK '#{id}' is configured twice."}

  defp add(keks, id, {:ok, key}),
    do: {:ok, %{keks | ids: keks.ids ++ [id], keys: Map.put(keks.keys, id, key)}}
end
