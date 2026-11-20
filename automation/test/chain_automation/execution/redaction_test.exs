defmodule ChainAutomation.Execution.RedactionTest do
  use ExUnit.Case, async: true

  alias ChainAutomation.Execution.{Outcomes, Redaction}
  alias ChainAutomation.Http.Request

  test "the longest value is replaced first, so a value inside another is not left half replaced" do
    values = Redaction.values(%{"short" => "abc", "long" => "abcdef"}, nil)

    assert values == [{"long", "abcdef"}, {"short", "abc"}]
    assert Redaction.scrub("x abcdef y abc", values) == "x [REDACTED:long] y [REDACTED:short]"
  end

  test "JSON is scrubbed in strings, keys and list items; other values are untouched" do
    values = Redaction.values(%{"key" => "k3y"}, nil)
    body = %{"k3y" => ["a k3y", 1, true, nil, %{"nested" => "k3y"}]}

    assert Redaction.scrub_answer(body, values) ==
             {:ok,
              %{
                "[REDACTED:key]" => [
                  "a [REDACTED:key]",
                  1,
                  true,
                  nil,
                  %{"nested" => "[REDACTED:key]"}
                ]
              }}
  end

  # Card #190: rebuilding an object with Map.new merged two keys that scrub to the same text, and lost one value.
  test "keys that would become the same text are never merged, at any depth" do
    values = Redaction.values(%{"key" => "k3y"}, nil)

    assert Redaction.scrub_answer(%{"k3y" => 1, "[REDACTED:key]" => 2}, values) == :keys_merged

    assert Redaction.scrub_answer([%{"a" => %{"x k3y" => 1, "x [REDACTED:key]" => 2}}], values) ==
             :keys_merged

    assert Redaction.scrub_answer(%{"k3y" => 1, "k3y k3y" => 2}, values) ==
             {:ok, %{"[REDACTED:key]" => 1, "[REDACTED:key] [REDACTED:key]" => 2}}
  end

  test "the encoded Basic credentials of the built request are scrubbed too; empty values are ignored" do
    request = %Request{
      method: "GET",
      url: "https://h/",
      headers: [{"Authorization", "Basic dXNlcjpwYXNz"}],
      body: nil
    }

    assert Redaction.values(%{"empty" => ""}, request) == [{"basic-auth", "dXNlcjpwYXNz"}]
  end

  test "an outcome's error message is cut to 500 characters" do
    error =
      Outcomes.error(%{class: :http_status, message: String.duplicate("é", 600), status: 502})

    assert error == %{
             "class" => "http_status",
             "message" => String.duplicate("é", 500),
             "status" => 502
           }
  end
end
