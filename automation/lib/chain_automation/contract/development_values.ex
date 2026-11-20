defmodule ChainAutomation.Contract.DevelopmentValues do
  @moduledoc """
  The development-only KEK and result token that docker-compose.yml supplies by default (automation.md §4.1, card #164). They
  are published, so a `prod` build refuses to start with them: `config/runtime.exs` calls `refuse!/2`. Only their SHA-256 is
  kept here, and findings name the setting, and a key's id, never a value.
  """

  alias ChainAutomation.Contract.Keks

  # SHA-256 of the development KEK's 32 bytes, and of the development result token.
  @key_sha256 Base.decode16!("90362fbaddb46c7f23175fd3e6da37d61785dd0e91d763357a3b5cc87bb9901e",
                case: :lower
              )
  @token_sha256 Base.decode16!("dcf5a1eb6a5bbb92ba48b910dd25245847b721798dc2e1c71dfa238e2e3f25d1",
                  case: :lower
                )

  @doc """
  What holds a development value: each key of `keks_config` with the development key's bytes, whatever its id, and the result
  token. `[]` when nothing does. A malformed ring is left to `Keks.load!/1`, which refuses it at startup with its own message.
  """
  @spec found(String.t() | nil, String.t() | nil) :: [String.t()]
  def found(keks_config, result_token) do
    keys =
      case Keks.parse(keks_config) do
        {:ok, keks} ->
          for id <- Keks.ids(keks),
              {:ok, key} <- [Keks.fetch(keks, id)],
              development?(key, @key_sha256),
              do: "CHAIN_AUTOMATION_KEKS holds the development key under the id '#{id}'"

        {:error, _} ->
          []
      end

    if is_binary(result_token) and development?(result_token, @token_sha256),
      do: keys ++ ["CHAIN_AUTOMATION_RESULT_TOKEN is the development token"],
      else: keys
  end

  @doc "Raises, naming the settings, when a development value is configured. A `prod` build calls it from `config/runtime.exs`."
  @spec refuse!(String.t() | nil, String.t() | nil) :: :ok
  def refuse!(keks_config, result_token) do
    case found(keks_config, result_token) do
      [] ->
        :ok

      found ->
        raise "Refusing to start a prod build: #{Enum.join(found, "; ")}. " <>
                "These development values of docker-compose.yml are published; configure your own (automation.md §4.1)."
    end
  end

  defp development?(value, sha256), do: :crypto.hash_equals(:crypto.hash(:sha256, value), sha256)
end
