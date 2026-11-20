defmodule ChainAutomation.Execution.Outcomes do
  @moduledoc """
  `automation.outcomes` (ADR-0011 §4; automation-contract.md §7): one final outcome per request, inserted in the same
  transaction as the `ReportResult` job that sends it to .NET. The primary key keeps it unique if an attempt is replayed.
  """

  alias ChainAutomation.Repo

  @message_limit 500

  @doc "The error of a failed outcome (automation-contract.md §4.2): the class, the message cut to 500 characters, the status."
  @spec error(%{class: atom(), message: String.t(), status: pos_integer() | nil}) :: map()
  def error(failure) do
    %{
      "class" => Atom.to_string(failure.class),
      "message" => String.slice(failure.message, 0, @message_limit),
      "status" => failure.status
    }
  end

  @spec recorded?(String.t()) :: boolean()
  def recorded?(request_id) do
    Repo.query!("SELECT 1 FROM automation.outcomes WHERE request_id = $1", [
      Ecto.UUID.dump!(request_id)
    ]).num_rows == 1
  end

  @spec record!(String.t(), pos_integer(), String.t(), map() | nil, map() | nil) :: :ok
  def record!(request_id, activation, outcome, output, error) do
    {:ok, _} =
      Repo.transaction(fn ->
        %{num_rows: inserted} =
          Repo.query!(
            "INSERT INTO automation.outcomes (request_id, activation, outcome, output, error) VALUES ($1, $2, $3, $4, $5) " <>
              "ON CONFLICT (request_id) DO NOTHING",
            [Ecto.UUID.dump!(request_id), activation, outcome, output, error]
          )

        if inserted == 1,
          do: Oban.insert!(ChainAutomation.Workers.ReportResult.new(%{"requestId" => request_id}))
      end)

    :ok
  end
end
