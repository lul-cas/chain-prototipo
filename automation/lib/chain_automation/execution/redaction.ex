defmodule ChainAutomation.Execution.Redaction do
  @moduledoc """
  Value-based scrubbing (ADR-0012 Part 3 §3): before anything about an attempt is stored, logged or returned, every
  occurrence of a secret's value is replaced with `[REDACTED:<name>]`, and the encoded `Basic` credentials with
  `[REDACTED:basic-auth]`. It covers messages and the output body, whose strings and keys may echo a key.
  """

  alias ChainAutomation.Http.Request

  @type values :: [{String.t(), String.t()}]

  @doc "What to scrub for an attempt, longest first, so a value inside another is not left half replaced."
  @spec values(%{String.t() => String.t()}, Request.t() | nil) :: values()
  def values(secrets, request) do
    basic =
      for %Request{headers: headers} <- [request],
          {"Authorization", "Basic " <> token} <- headers,
          do: {"basic-auth", token}

    (Enum.to_list(secrets) ++ basic)
    |> Enum.reject(fn {_label, value} -> value == "" end)
    |> Enum.sort_by(fn {_label, value} -> byte_size(value) end, :desc)
  end

  @doc "Scrubs text."
  @spec scrub(String.t(), values()) :: String.t()
  def scrub(text, values) when is_binary(text),
    do:
      Enum.reduce(values, text, fn {label, value}, text ->
        String.replace(text, value, "[REDACTED:#{label}]")
      end)

  @doc """
  Scrubs a decoded JSON answer: its strings, and the keys and items of its objects and lists. It answers `:keys_merged` when two
  keys of one object would become the same text, since one of their values would be lost (automation-contract.md §7, card
  #190).
  """
  @spec scrub_answer(term(), values()) :: {:ok, term()} | :keys_merged
  def scrub_answer(answer, values) do
    {:ok, scrub_value(answer, values)}
  catch
    :keys_merged -> :keys_merged
  end

  defp scrub_value(text, values) when is_binary(text), do: scrub(text, values)

  defp scrub_value(map, values) when is_map(map) do
    scrubbed =
      Map.new(map, fn {key, value} -> {scrub(key, values), scrub_value(value, values)} end)

    if map_size(scrubbed) == map_size(map), do: scrubbed, else: throw(:keys_merged)
  end

  defp scrub_value(list, values) when is_list(list), do: Enum.map(list, &scrub_value(&1, values))
  defp scrub_value(other, _values), do: other
end
