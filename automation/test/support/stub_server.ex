defmodule ChainAutomation.StubServer do
  @moduledoc """
  A small HTTP/1.1 server for the adapter's tests. It listens on a private address of this machine, never on loopback,
  because the adapter refuses loopback for every destination: the tests use `internal` destinations, as a service inside
  the deployment would. Each request is sent to the test process as `{:stub_request, request}` and answered by the
  handler, which returns `{status, headers, body}`, `{:delay, ms, answer}`, `{:raw, bytes}` or `:close`.
  """

  alias ChainAutomation.Http.AddressPolicy

  @doc "A private IPv4 address (RFC 1918) of an interface that is up; the tests need one."
  def private_address! do
    {:ok, interfaces} = :inet.getifaddrs()

    addresses =
      for {_name, options} <- interfaces,
          :up in Keyword.get(options, :flags, []),
          {:addr, {_, _, _, _} = address} <- options,
          AddressPolicy.check(address, false) == {:forbidden, :private},
          do: address

    List.first(addresses) ||
      raise "these tests need a private IPv4 address (RFC 1918) on an interface that is up"
  end

  @doc "Starts a server answering with `handler`; `tls:` takes the server options of `:public_key.pkix_test_data/1`."
  def start!(handler, opts \\ []) do
    test = self()
    ip = private_address!()
    {transport, listen_options} = transport(opts[:tls])

    {:ok, listener} =
      transport.listen(0, [:binary, ip: ip, active: false, reuseaddr: true] ++ listen_options)

    {:ok, {_, port}} = sockname(transport, listener)
    pid = spawn_link(fn -> accept_loop(transport, listener, handler, test) end)
    %{ip: ip, port: port, pid: pid}
  end

  @doc "A port on the private address where nothing listens."
  def closed_port! do
    {:ok, listener} = :gen_tcp.listen(0, ip: private_address!())
    {:ok, port} = :inet.port(listener)
    :ok = :gen_tcp.close(listener)
    port
  end

  defp transport(nil), do: {:gen_tcp, [packet: :raw]}
  defp transport(tls), do: {:ssl, tls}

  defp sockname(:gen_tcp, listener), do: :inet.sockname(listener)
  defp sockname(:ssl, listener), do: :ssl.sockname(listener)

  defp accept_loop(transport, listener, handler, test) do
    case accept(transport, listener) do
      {:ok, socket} ->
        pid = spawn(fn -> serve(transport, socket, handler, test) end)
        transport.controlling_process(socket, pid)
        send(pid, :go)

      {:error, _handshake_refused_by_the_client} ->
        :ok
    end

    accept_loop(transport, listener, handler, test)
  end

  defp accept(:gen_tcp, listener), do: :gen_tcp.accept(listener)

  defp accept(:ssl, listener) do
    with {:ok, socket} <- :ssl.transport_accept(listener), do: :ssl.handshake(socket, 5_000)
  end

  defp serve(transport, socket, handler, test) do
    receive do
      :go -> :ok
    end

    with {:ok, request} <- read_request(transport, socket, "") do
      send(test, {:stub_request, request})
      answer(transport, socket, handler.(request))
    end

    transport.close(socket)
  end

  defp read_request(transport, socket, buffer) do
    case :binary.split(buffer, "\r\n\r\n") do
      [head, rest] ->
        [request_line | header_lines] = String.split(head, "\r\n")
        [method, path, _version] = String.split(request_line, " ")

        headers =
          Enum.map(header_lines, fn line ->
            [name, value] = String.split(line, ":", parts: 2)
            {String.downcase(name), String.trim(value)}
          end)

        length =
          headers
          |> List.keyfind("content-length", 0, {nil, "0"})
          |> elem(1)
          |> String.to_integer()

        with {:ok, body} <- read_body(transport, socket, rest, length) do
          {:ok, %{method: method, path: path, headers: headers, body: body}}
        end

      [_incomplete] ->
        with {:ok, data} <- transport.recv(socket, 0, 5_000),
             do: read_request(transport, socket, buffer <> data)
    end
  end

  defp read_body(_transport, _socket, body, length) when byte_size(body) >= length,
    do: {:ok, body}

  defp read_body(transport, socket, body, length) do
    with {:ok, data} <- transport.recv(socket, 0, 5_000),
         do: read_body(transport, socket, body <> data, length)
  end

  defp answer(_transport, _socket, :close), do: :ok
  defp answer(transport, socket, {:raw, bytes}), do: transport.send(socket, bytes)

  defp answer(transport, socket, {:delay, ms, answer}) do
    Process.sleep(ms)
    answer(transport, socket, answer)
  end

  defp answer(transport, socket, {status, headers, body}) do
    lines =
      Enum.map(headers ++ [{"content-length", byte_size(body)}, {"connection", "close"}], fn {n,
                                                                                              v} ->
        "#{n}: #{v}\r\n"
      end)

    transport.send(socket, ["HTTP/1.1 #{status} Stub\r\n", lines, "\r\n", body])
  end
end
