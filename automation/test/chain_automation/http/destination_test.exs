defmodule ChainAutomation.Http.DestinationTest do
  use ExUnit.Case, async: true

  alias ChainAutomation.Http.Destination

  @erp %{name: "erp", scheme: "https", host: "api.erp.example", port: nil, path_prefix: "/v1"}

  defp denied(url, destination \\ @erp) do
    assert {:error, :destination_denied, message} = Destination.check_url(url, destination)
    message
  end

  test "a URL inside the destination passes" do
    for url <- [
          "https://api.erp.example/v1",
          "https://api.erp.example/v1/clientes/123.456%2F78%209/consultas?origem=chain&valor=1500",
          "https://api.erp.example:443/v1/x",
          "https://API.Erp.Example/v1/x"
        ] do
      assert Destination.check_url(url, @erp) == :ok, url
    end
  end

  test "each part outside the destination is denied, and the message says which" do
    assert denied("http://api.erp.example/v1/x") ==
             "The URL does not match the destination 'erp': the scheme 'http'."

    assert denied("https://other.example/v1/x") ==
             "The URL does not match the destination 'erp': the host 'other.example'."

    assert denied("https://api.erp.example.evil.test/v1") =~
             "the host 'api.erp.example.evil.test'"

    assert denied("https://api.erp.example:8443/v1/x") ==
             "The URL does not match the destination 'erp': the port 8443."

    assert denied("https://api.erp.example/v2/x") ==
             "The URL does not match the destination 'erp': the path."

    assert denied("https://api.erp.example/v1x") =~ "the path"

    assert denied("https://user:pass@api.erp.example/v1/x") ==
             "The URL does not match the destination 'erp': user info."

    assert denied("https://api.erp.example/v1/x#part") ==
             "The URL does not match the destination 'erp': a fragment."

    assert denied("/v1/relative") ==
             "The URL does not match the destination 'erp': not an absolute URL."

    assert denied("https://[::1]/v1") =~ "the host '::1'"
    assert denied("not a url") =~ "not an absolute URL"
  end

  test "a dot segment, written plainly or percent-encoded, is denied: it could climb out of the prefix" do
    for url <- [
          "https://api.erp.example/v1/../admin",
          "https://api.erp.example/v1/./x",
          "https://api.erp.example/v1/%2e%2e/admin",
          "https://api.erp.example/v1/%2E/x",
          "https://api.erp.example/v1/.%2e"
        ] do
      assert denied(url) == "The URL does not match the destination 'erp': a dot segment.", url
    end

    assert Destination.check_url("https://api.erp.example/v1/..x/.y", @erp) == :ok

    # A malformed escape is not a dot segment, and it must not raise: no exception leaves the adapter.
    assert Destination.check_url("https://api.erp.example/v1/%zz/x%2", @erp) == :ok
  end

  test "a wildcard covers proper subdomains only" do
    wildcard = %{@erp | host: "*.erp.example"}

    assert Destination.check_url("https://api.erp.example/v1/x", wildcard) == :ok
    assert Destination.check_url("https://a.b.erp.example/v1/x", wildcard) == :ok
    assert denied("https://erp.example/v1/x", wildcard) =~ "the host 'erp.example'"
    assert denied("https://xerp.example/v1/x", wildcard) =~ "the host 'xerp.example'"
  end

  test "a set port must be used, and without one the scheme's default" do
    with_port = %{@erp | port: 8443}

    assert Destination.check_url("https://api.erp.example:8443/v1/x", with_port) == :ok
    assert denied("https://api.erp.example/v1/x", with_port) =~ "the port 443"

    assert Destination.check_url("http://h.internal/v1", %{
             @erp
             | scheme: "http",
               host: "h.internal"
           }) == :ok
  end

  test "the prefix rule is .NET's: equal to the prefix with or without its trailing slash, or continued after one" do
    slash = %{@erp | path_prefix: "/v1/"}

    assert Destination.check_url("https://api.erp.example/v1/", slash) == :ok
    assert Destination.check_url("https://api.erp.example/v1", slash) == :ok
    assert Destination.check_url("https://api.erp.example/v1/x", slash) == :ok
    assert denied("https://api.erp.example/v10", slash) =~ "the path"

    for no_prefix <- [nil, "/"] do
      assert Destination.check_url("https://api.erp.example/", %{@erp | path_prefix: no_prefix}) ==
               :ok

      assert Destination.check_url("https://api.erp.example/any/path", %{
               @erp
               | path_prefix: no_prefix
             }) == :ok
    end
  end
end
