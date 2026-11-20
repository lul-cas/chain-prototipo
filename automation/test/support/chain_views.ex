defmodule ChainAutomation.ChainViews do
  @moduledoc """
  A stand-in for the part of .NET's `chain` schema that Elixir reads (automation-contract.md §2): the outbox and the
  secrets, each with the columns its view needs, and both views exactly as the contract defines them. The test database
  has no .NET migrations.
  """

  alias ChainAutomation.Repo

  @doc "Creates the stand-in once per test run; it is idempotent."
  def create! do
    Repo.query!("CREATE SCHEMA IF NOT EXISTS chain")

    Repo.query!("""
    CREATE TABLE IF NOT EXISTS chain.automation_work_requests (
      id uuid PRIMARY KEY,
      kind text NOT NULL,
      status text NOT NULL,
      cancels_request_id uuid,
      payload jsonb,
      created_at timestamptz NOT NULL,
      deadline_at timestamptz NOT NULL
    )
    """)

    Repo.query!("""
    CREATE OR REPLACE VIEW chain.automation_dispatch_v1 AS
    SELECT id AS request_id, kind, cancels_request_id, payload, created_at, deadline_at
    FROM chain.automation_work_requests
    WHERE status = 'pending'
    """)

    Repo.query!("""
    CREATE TABLE IF NOT EXISTS chain.automation_secrets (
      name text PRIMARY KEY,
      description text,
      version integer NOT NULL,
      ciphertext bytea NOT NULL,
      nonce bytea NOT NULL,
      wrapped_data_key bytea NOT NULL,
      key_id text NOT NULL,
      allowed_destinations text[] NOT NULL
    )
    """)

    Repo.query!("""
    CREATE OR REPLACE VIEW chain.automation_secrets_v1 AS
    SELECT name, version, ciphertext, nonce, wrapped_data_key, key_id, allowed_destinations
    FROM chain.automation_secrets
    """)
  end

  @doc "Writes an outbox row as .NET does at dispatch (`execute`) or on close (`cancel`)."
  def insert!(id, kind, opts \\ []) do
    created_at = Keyword.get(opts, :created_at, DateTime.utc_now())

    Repo.query!(
      "INSERT INTO chain.automation_work_requests (id, kind, status, cancels_request_id, payload, created_at, deadline_at) " <>
        "VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [
        Ecto.UUID.dump!(id),
        kind,
        Keyword.get(opts, :status, "pending"),
        opts[:cancels] && Ecto.UUID.dump!(opts[:cancels]),
        opts[:payload],
        created_at,
        DateTime.add(created_at, 990)
      ]
    )

    id
  end

  @doc "Marks a request as .NET does when it closes it (`cancelled`, `timed_out`, …)."
  def set_status!(id, status),
    do:
      Repo.query!("UPDATE chain.automation_work_requests SET status = $2 WHERE id = $1", [
        Ecto.UUID.dump!(id),
        status
      ])

  @doc "Stores a secret as .NET does: sealed with the KEK `{key_id, key}` (automation-contract.md §5)."
  def put_secret!(name, version, value, allowed_destinations, {key_id, kek}) do
    sealed = seal(kek, key_id, name, version, value)

    Repo.query!(
      "INSERT INTO chain.automation_secrets (name, version, ciphertext, nonce, wrapped_data_key, key_id, allowed_destinations) " <>
        "VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [
        name,
        version,
        sealed.ciphertext,
        sealed.nonce,
        sealed.wrapped_data_key,
        key_id,
        allowed_destinations
      ]
    )
  end

  @doc "The envelope of automation-contract.md §5, written independently of the module that opens it."
  def seal(kek, key_id, name, version, value) do
    data_key = :crypto.strong_rand_bytes(32)
    {nonce, wrap_nonce} = {:crypto.strong_rand_bytes(12), :crypto.strong_rand_bytes(12)}

    {ciphertext, tag} =
      :crypto.crypto_one_time_aead(
        :aes_256_gcm,
        data_key,
        nonce,
        value,
        "chain.secret.v1|#{name}|#{version}",
        true
      )

    {wrapped, wrap_tag} =
      :crypto.crypto_one_time_aead(
        :aes_256_gcm,
        kek,
        wrap_nonce,
        data_key,
        "chain.dek.v1|#{key_id}|#{name}|#{version}",
        true
      )

    %{
      name: name,
      version: version,
      key_id: key_id,
      nonce: nonce,
      ciphertext: ciphertext <> tag,
      wrapped_data_key: wrap_nonce <> wrapped <> wrap_tag
    }
  end

  @doc """
  Moves a stored secret to another KEK as .NET's `automation-keks rewrap` does (ADR-0017 §5.2): the data key is unwrapped
  with the old KEK and wrapped with the new one, so only `wrapped_data_key` and `key_id` change. Written independently of
  both services, as `seal/5` is.
  """
  def rewrap!(name, {from_id, from_kek}, {to_id, to_kek}) do
    %{rows: [[version, wrapped_data_key]]} =
      Repo.query!(
        "SELECT version, wrapped_data_key FROM chain.automation_secrets WHERE name = $1",
        [name]
      )

    <<wrap_nonce::binary-size(12), wrapped::binary-size(32), wrap_tag::binary-size(16)>> =
      wrapped_data_key

    data_key =
      :crypto.crypto_one_time_aead(
        :aes_256_gcm,
        from_kek,
        wrap_nonce,
        wrapped,
        "chain.dek.v1|#{from_id}|#{name}|#{version}",
        wrap_tag,
        false
      )

    true = is_binary(data_key)
    new_nonce = :crypto.strong_rand_bytes(12)

    {rewrapped, new_tag} =
      :crypto.crypto_one_time_aead(
        :aes_256_gcm,
        to_kek,
        new_nonce,
        data_key,
        "chain.dek.v1|#{to_id}|#{name}|#{version}",
        true
      )

    Repo.query!(
      "UPDATE chain.automation_secrets SET wrapped_data_key = $2, key_id = $3 WHERE name = $1",
      [name, new_nonce <> rewrapped <> new_tag, to_id]
    )
  end
end
