defmodule ChainAutomation.Http.AddressPolicy do
  @moduledoc """
  Which resolved addresses an automation may connect to (ADR-0012 Part 2 rule 3; automation.md §8.5). Loopback, link-local,
  unspecified, multicast and reserved addresses are always forbidden. Private and CGNAT addresses are allowed only for an
  `internal` destination. IPv6 forms that carry an IPv4 address (mapped, NAT64, 6to4) are judged by that address.
  """

  import Bitwise

  @type category ::
          :loopback | :link_local | :unspecified | :multicast | :reserved | :private | :cgnat

  @spec check(:inet.ip_address(), boolean()) :: :ok | {:forbidden, category()}
  def check(address, internal?) do
    case category(address) do
      :public -> :ok
      allowed when allowed in [:private, :cgnat] and internal? -> :ok
      forbidden -> {:forbidden, forbidden}
    end
  end

  @spec describe(category()) :: String.t()
  def describe(:loopback), do: "a loopback address"
  def describe(:link_local), do: "a link-local address"
  def describe(:unspecified), do: "an unspecified address"
  def describe(:multicast), do: "a multicast address"
  def describe(:reserved), do: "a reserved address"
  def describe(:private), do: "a private address"
  def describe(:cgnat), do: "a CGNAT address"

  defp category({0, _, _, _}), do: :unspecified
  defp category({10, _, _, _}), do: :private
  defp category({100, b, _, _}) when b in 64..127, do: :cgnat
  defp category({127, _, _, _}), do: :loopback
  defp category({169, 254, _, _}), do: :link_local
  defp category({172, b, _, _}) when b in 16..31, do: :private
  defp category({192, 168, _, _}), do: :private
  defp category({a, _, _, _}) when a in 224..239, do: :multicast
  defp category({a, _, _, _}) when a >= 240, do: :reserved
  defp category({_, _, _, _}), do: :public

  defp category({0, 0, 0, 0, 0, 0, 0, 0}), do: :unspecified
  defp category({0, 0, 0, 0, 0, 0, 0, 1}), do: :loopback
  defp category({0, 0, 0, 0, 0, 0xFFFF, high, low}), do: category(ipv4(high, low))
  # The deprecated IPv4-compatible form.
  defp category({0, 0, 0, 0, 0, 0, _, _}), do: :reserved
  # NAT64 (RFC 6052) and 6to4 (RFC 3056) reach the IPv4 address they carry.
  defp category({0x64, 0xFF9B, 0, 0, 0, 0, high, low}), do: category(ipv4(high, low))
  defp category({0x2002, high, low, _, _, _, _, _}), do: category(ipv4(high, low))
  defp category({first, _, _, _, _, _, _, _}) when first >= 0xFF00, do: :multicast
  defp category({first, _, _, _, _, _, _, _}) when first in 0xFE80..0xFEBF, do: :link_local
  # Unique local (fc00::/7) and the deprecated site-local (fec0::/10).
  defp category({first, _, _, _, _, _, _, _})
       when first in 0xFC00..0xFDFF or first in 0xFEC0..0xFEFF, do: :private

  defp category({_, _, _, _, _, _, _, _}), do: :public

  defp ipv4(high, low), do: {high >>> 8, high &&& 0xFF, low >>> 8, low &&& 0xFF}
end
