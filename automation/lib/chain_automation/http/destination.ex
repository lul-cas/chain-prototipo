defmodule ChainAutomation.Http.Destination do
  @moduledoc """
  Checks a URL against the destination snapshot of the payload (automation.md §8.1 step 2 and §8.5), on every attempt and
  every redirect: the scheme, the host (exact, or a proper subdomain of a `*.` wildcard), the port, and the path prefix,
  with .NET's prefix rule. User info, fragments and dot segments are refused.
  """

  @type destination :: %{
          required(:name) => String.t(),
          required(:scheme) => String.t(),
          required(:host) => String.t(),
          required(:port) => pos_integer() | nil,
          required(:path_prefix) => String.t() | nil,
          optional(atom()) => term()
        }

  @spec check_url(String.t(), destination()) :: :ok | {:error, :destination_denied, String.t()}
  def check_url(url, destination) do
    with {:ok, uri} <- absolute(url),
         :ok <- expect(uri.userinfo == nil, "user info"),
         :ok <- expect(uri.fragment == nil, "a fragment"),
         :ok <- expect(uri.scheme == destination.scheme, "the scheme '#{uri.scheme}'"),
         :ok <-
           expect(host?(String.downcase(uri.host), destination.host), "the host '#{uri.host}'"),
         :ok <-
           expect(
             uri.port == (destination.port || default_port(destination.scheme)),
             "the port #{uri.port}"
           ),
         :ok <- expect(no_dot_segments?(uri.path || ""), "a dot segment"),
         :ok <- expect(within_prefix?(uri.path || "", destination.path_prefix), "the path") do
      :ok
    else
      {:mismatch, what} ->
        {:error, :destination_denied,
         "The URL does not match the destination '#{destination.name}': #{what}."}
    end
  end

  @spec default_port(String.t()) :: 80 | 443
  def default_port("https"), do: 443
  def default_port("http"), do: 80

  defp absolute(url) do
    case URI.new(url) do
      {:ok, %URI{scheme: scheme, host: host} = uri}
      when is_binary(scheme) and is_binary(host) and host != "" ->
        {:ok, uri}

      _ ->
        {:mismatch, "not an absolute URL"}
    end
  end

  defp expect(true, _what), do: :ok
  defp expect(false, what), do: {:mismatch, what}

  defp host?(host, "*." <> _ = pattern),
    do: String.ends_with?(host, String.trim_leading(pattern, "*"))

  defp host?(host, exact), do: host == exact

  # A `.` or `..` segment, plain or percent-encoded, could climb out of the prefix on a server that normalizes paths.
  defp no_dot_segments?(path) do
    path
    |> String.split("/")
    |> Enum.all?(fn segment -> URI.decode(segment) not in [".", ".."] end)
  end

  # .NET's rule (AutomationRules.WithinPrefix): the prefix itself, without its trailing slash, or continued after a `/`.
  defp within_prefix?(_path, nil), do: true

  defp within_prefix?(path, prefix) do
    root = String.trim_trailing(prefix, "/")
    root == "" or path in [prefix, root] or String.starts_with?(path, root <> "/")
  end
end
