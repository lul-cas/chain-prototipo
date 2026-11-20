defmodule ChainAutomation.Contract.DevelopmentValuesTest do
  # The development KEK and result token that docker-compose.yml supplies by default (automation.md §4.1, card #164).
  use ExUnit.Case, async: true

  alias ChainAutomation.ContractFixture
  alias ChainAutomation.Contract.DevelopmentValues

  @compose Path.expand("../../../../docker-compose.yml", __DIR__)
  @other_key Base.encode64(:binary.copy(<<7>>, 32))

  setup do
    values = ContractFixture.read!("development-values.json")
    [_id, material] = String.split(values["keks"], ":", parts: 2)
    %{values: values, material: material}
  end

  test "the fixture still holds docker-compose.yml's defaults", %{values: values} do
    compose = File.read!(@compose)

    for {variable, expected} <- [
          {"CHAIN_AUTOMATION_KEKS", values["keks"]},
          {"CHAIN_AUTOMATION_RESULT_TOKEN", values["resultToken"]},
          {"CHAIN_AUTOMATION_RESULT_TOKEN_SHA256", values["resultTokenSha256"]}
        ] do
      defaults = Regex.scan(~r/\$\{#{variable}:-([^}]+)\}/, compose, capture: :all_but_first)
      assert defaults != [], "docker-compose.yml has no default for #{variable}"
      assert Enum.uniq(List.flatten(defaults)) == [expected]
    end

    assert Base.encode16(:crypto.hash(:sha256, values["resultToken"]), case: :lower) ==
             values["resultTokenSha256"]
  end

  test "the development key is found under any id and named without its material", %{
    material: material
  } do
    assert [finding] = DevelopmentValues.found("k2026-10:#{material},other:#{@other_key}", nil)
    assert finding =~ "CHAIN_AUTOMATION_KEKS"
    assert finding =~ "'k2026-10'"
    refute finding =~ material
  end

  test "the development result token is found and named without it", %{values: values} do
    assert [finding] = DevelopmentValues.found(nil, values["resultToken"])
    assert finding =~ "CHAIN_AUTOMATION_RESULT_TOKEN"
    refute finding =~ values["resultToken"]
  end

  test "other keys and tokens are not development values, whatever their id" do
    assert DevelopmentValues.found("dev:#{@other_key}", "another-token") == []
    assert DevelopmentValues.found(nil, nil) == []
    # A malformed ring is left to Keks.load!/1, which refuses it at startup.
    assert DevelopmentValues.found("not a ring", nil) == []
  end
end
