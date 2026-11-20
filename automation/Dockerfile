# Development image for the automation subsystem (Elixir + Oban).
FROM elixir:1.20.2-otp-29
ENV MIX_ENV=dev
# The service holds the KEKs in memory, so a crash of the Erlang VM writes no erl_crash.dump (automation.md §4.1, card #164).
ENV ERL_CRASH_DUMP_SECONDS=0
WORKDIR /app
RUN mix local.hex --force && mix local.rebar --force
COPY mix.exs mix.lock ./
RUN mix deps.get && mix deps.compile
COPY config config
COPY lib lib
COPY priv priv
RUN mix compile --warnings-as-errors
CMD ["sh", "-c", "mix ecto.migrate && mix run --no-halt"]
