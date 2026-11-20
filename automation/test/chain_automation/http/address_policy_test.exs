defmodule ChainAutomation.Http.AddressPolicyTest do
  use ExUnit.Case, async: true

  alias ChainAutomation.Http.AddressPolicy

  defp ip(text) do
    {:ok, address} = :inet.parse_address(String.to_charlist(text))
    address
  end

  @always_forbidden [
    {"127.0.0.1", :loopback},
    {"127.255.255.254", :loopback},
    {"::1", :loopback},
    {"169.254.169.254", :link_local},
    {"169.254.0.1", :link_local},
    {"fe80::1", :link_local},
    {"febf::1", :link_local},
    {"0.0.0.0", :unspecified},
    {"0.1.2.3", :unspecified},
    {"::", :unspecified},
    {"224.0.0.1", :multicast},
    {"239.255.255.250", :multicast},
    {"ff02::1", :multicast},
    {"240.0.0.1", :reserved},
    {"255.255.255.255", :reserved},
    {"::8.8.8.8", :reserved},
    {"::ffff:127.0.0.1", :loopback},
    {"::ffff:169.254.169.254", :link_local},
    {"64:ff9b::7f00:1", :loopback},
    {"64:ff9b::a9fe:a9fe", :link_local},
    {"2002:7f00:1::", :loopback},
    {"2002:a9fe:a9fe::1", :link_local}
  ]

  @forbidden_unless_internal [
    {"10.0.0.1", :private},
    {"10.255.255.255", :private},
    {"172.16.0.1", :private},
    {"172.31.255.255", :private},
    {"192.168.1.1", :private},
    {"fc00::1", :private},
    {"fd12:3456::1", :private},
    {"fec0::1", :private},
    {"100.64.0.1", :cgnat},
    {"100.127.255.255", :cgnat},
    {"::ffff:10.0.0.1", :private},
    {"64:ff9b::a00:1", :private},
    {"2002:c0a8:101::", :private}
  ]

  @public [
            "93.184.215.14",
            "8.8.8.8",
            "172.32.0.1",
            "172.15.255.255",
            "100.128.0.1",
            "100.63.255.255",
            "11.0.0.1"
          ] ++
            [
              "2606:4700::1111",
              "::ffff:8.8.8.8",
              "64:ff9b::808:808",
              "2002:808:808::",
              "fbff::1",
              "fe7f::1"
            ]

  test "loopback, link-local, unspecified, multicast and reserved addresses are always forbidden" do
    for {text, category} <- @always_forbidden, internal <- [false, true] do
      assert AddressPolicy.check(ip(text), internal) == {:forbidden, category},
             "#{text} internal=#{internal}"
    end
  end

  test "private and CGNAT addresses are forbidden unless the destination is internal" do
    for {text, category} <- @forbidden_unless_internal do
      assert AddressPolicy.check(ip(text), false) == {:forbidden, category}, text
      assert AddressPolicy.check(ip(text), true) == :ok, text
    end
  end

  test "public addresses, including the edges of the forbidden ranges, are allowed" do
    for text <- @public, internal <- [false, true] do
      assert AddressPolicy.check(ip(text), internal) == :ok, "#{text} internal=#{internal}"
    end
  end

  test "each category has a readable name for messages" do
    assert AddressPolicy.describe(:link_local) == "a link-local address"
    assert AddressPolicy.describe(:cgnat) == "a CGNAT address"
  end
end
