using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Chain.Api.Tests.Infrastructure;
using static Chain.Api.Tests.Engine.CreditScenario;

namespace Chain.Api.Tests.Engine;

/// <summary>The instance version as an ETag (workflow-engine.md §9, ADR-0008 §3, card #50), needed by data correction (§16).</summary>
[Collection(PostgresTestGroup.Name)]
public sealed class InstanceETagTests(PostgresFixture postgres) : IAsyncLifetime, IDisposable
{
    private readonly ChainApiFactory _factory = new(postgres.ConnectionString);
    private CreditScenario _s = null!;

    public async Task InitializeAsync()
    {
        await _factory.ResetDatabaseAsync();
        _s = await CreditScenario.CreateAsync(_factory);
    }

    public Task DisposeAsync() => Task.CompletedTask;

    public void Dispose()
    {
        _s?.Dispose();
        _factory.Dispose();
    }

    [Fact]
    public async Task Get_returns_the_instance_version_as_a_strong_etag_and_in_the_body()
    {
        var instanceId = await StartedInstanceAsync(_s.Ana, _s.DefinitionId);

        var response = await _s.Ana.GetAsync($"/api/instances/{instanceId}");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var etag = response.Headers.ETag!;
        Assert.False(etag.IsWeak);
        Assert.Matches("^\"[0-9]+\"$", etag.Tag);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(etag.Tag, $"\"{body.GetProperty("version").GetUInt32()}\"");
    }

    [Fact]
    public async Task Commands_return_the_new_version_and_it_changes_when_the_instance_changes()
    {
        var started = await StartAsync(_s.Ana, _s.DefinitionId);
        Assert.Equal(HttpStatusCode.Created, started.StatusCode);
        var instanceId = Id(await started.Content.ReadFromJsonAsync<JsonElement>());
        Assert.Equal(started.Headers.ETag!.Tag, await ETagAsync(_s.Ana, instanceId));

        var completed = await CompleteAsync(_s.Ana, Id(await OpenTaskAsync(_s.Ana, instanceId)));
        Assert.Equal(HttpStatusCode.OK, completed.StatusCode);
        Assert.NotEqual(started.Headers.ETag!.Tag, completed.Headers.ETag!.Tag);
        Assert.Equal(completed.Headers.ETag!.Tag, await ETagAsync(_s.Ana, instanceId));

        var analysed = await CompleteAsync(_s.Bruno, Id(await OpenTaskAsync(_s.Bruno, instanceId)));
        var decided = await DecideAsync(_s.Bruno, Id(await OpenTaskAsync(_s.Bruno, instanceId)), outcome: false);
        Assert.Equal(HttpStatusCode.OK, decided.StatusCode);
        Assert.NotEqual(analysed.Headers.ETag!.Tag, decided.Headers.ETag!.Tag);
        Assert.Equal(decided.Headers.ETag!.Tag, await ETagAsync(_s.Ana, instanceId));

        var closed = await CloseAsync(_s.Ana, instanceId, "desisti");
        Assert.Equal(HttpStatusCode.OK, closed.StatusCode);
        Assert.NotEqual(decided.Headers.ETag!.Tag, closed.Headers.ETag!.Tag);
        Assert.Equal(closed.Headers.ETag!.Tag, await ETagAsync(_s.Ana, instanceId));
    }

    [Fact]
    public async Task A_comment_returns_the_new_version()
    {
        var instanceId = await StartedInstanceAsync(_s.Ana, _s.DefinitionId);
        var before = await ETagAsync(_s.Ana, instanceId);

        var commented = await PostAsync(_s.Ana, $"/api/instances/{instanceId}/comments", new { text = "Segue o contrato." }, NewKey());

        Assert.Equal(HttpStatusCode.OK, commented.StatusCode);
        var etag = Assert.IsType<System.Net.Http.Headers.EntityTagHeaderValue>(commented.Headers.ETag); // #70
        Assert.NotEqual(before, etag.Tag); // comment.added is a timeline event, so the version changes
        Assert.Equal(etag.Tag, await ETagAsync(_s.Ana, instanceId));
        var body = await commented.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(etag.Tag, $"\"{body.GetProperty("version").GetUInt32()}\"");
    }

    [Fact]
    public async Task A_replayed_command_returns_the_version_it_produced()
    {
        var key = NewKey();
        var first = await StartAsync(_s.Ana, _s.DefinitionId, key);
        var replay = await StartAsync(_s.Ana, _s.DefinitionId, key);

        Assert.Equal(HttpStatusCode.Created, replay.StatusCode);
        Assert.Equal(first.Headers.ETag!.Tag, replay.Headers.ETag!.Tag);
    }

    [Fact]
    public async Task Problems_carry_no_etag()
    {
        var instanceId = await StartedInstanceAsync(_s.Ana, _s.DefinitionId);

        var hidden = await _s.Fabio.GetAsync($"/api/instances/{instanceId}");

        Assert.Equal(HttpStatusCode.NotFound, hidden.StatusCode);
        Assert.Null(hidden.Headers.ETag);
    }

    private static async Task<string> ETagAsync(HttpClient client, Guid instanceId) =>
        (await client.GetAsync($"/api/instances/{instanceId}")).Headers.ETag!.Tag;
}
