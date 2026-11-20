defmodule ChainAutomation.RuntimeConfigTest do
  # Reads config/runtime.exs as a prod or dev build would, with the environment variables it reads set here; they are
  # process-wide, so this module does not run alongside others.
  use ExUnit.Case, async: false

  alias ChainAutomation.ContractFixture

  @runtime Path.expand("../../config/runtime.exs", __DIR__)
  @variables ~w(DATABASE_URL CHAIN_AUTOMATION_KEKS CHAIN_AUTOMATION_RESULT_URL CHAIN_AUTOMATION_RESULT_TOKEN)
  @other_key Base.encode64(:binary.copy(<<7>>, 32))

  setup do
    saved = Map.new(@variables, &{&1, System.get_env(&1)})

    on_exit(fn ->
      for {name, value} <- saved,
          do: if(value, do: System.put_env(name, value), else: System.delete_env(name))
    end)

    System.put_env(%{
      "DATABASE_URL" => "ecto://chain:chain@db.internal:5432/chain",
      "CHAIN_AUTOMATION_KEKS" => "k1:#{@other_key}",
      "CHAIN_AUTOMATION_RESULT_URL" => "http://api:8081/internal/automation/results",
      "CHAIN_AUTOMATION_RESULT_TOKEN" => "a-real-token-of-forty-three-characters-xyz0"
    })

    %{values: ContractFixture.read!("development-values.json")}
  end

  # Card #164: docker-compose.yml's development KEK and result token are published (automation.md §4.1).

  test "a prod build refuses the development key, naming the setting and not the value", %{
    values: values
  } do
    System.put_env("CHAIN_AUTOMATION_KEKS", "k1:#{@other_key},#{values["keks"]}")

    error = assert_raise RuntimeError, fn -> Config.Reader.read!(@runtime, env: :prod) end

    assert error.message =~ "CHAIN_AUTOMATION_KEKS"
    refute error.message =~ String.split(values["keks"], ":", parts: 2) |> List.last()
  end

  test "a prod build refuses the development result token, naming the setting and not the value",
       %{values: values} do
    System.put_env("CHAIN_AUTOMATION_RESULT_TOKEN", values["resultToken"])

    error = assert_raise RuntimeError, fn -> Config.Reader.read!(@runtime, env: :prod) end

    assert error.message =~ "CHAIN_AUTOMATION_RESULT_TOKEN"
    refute error.message =~ values["resultToken"]
  end

  test "a prod build starts with other values, and a dev build with the development ones", %{
    values: values
  } do
    assert Config.Reader.read!(@runtime, env: :prod)[:chain_automation][:keks] ==
             "k1:#{@other_key}"

    System.put_env(%{
      "CHAIN_AUTOMATION_KEKS" => values["keks"],
      "CHAIN_AUTOMATION_RESULT_TOKEN" => values["resultToken"]
    })

    assert Config.Reader.read!(@runtime, env: :dev)[:chain_automation][:keks] == values["keks"]
  end
end
