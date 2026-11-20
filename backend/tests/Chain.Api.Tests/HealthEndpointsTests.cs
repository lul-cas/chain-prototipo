using System.Net;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Chain.Api.Tests;

public sealed class HealthEndpointsTests
{
    // Port 1 is reserved and never has a PostgreSQL listener, so readiness must fail.
    private const string UnreachableDatabase =
        "Host=127.0.0.1;Port=1;Database=chain;Username=chain;Password=chain;Timeout=2";

    [Fact]
    public async Task Liveness_returns_healthy_without_checking_dependencies()
    {
        await using var factory = CreateFactory(UnreachableDatabase);
        using var client = factory.CreateClient();

        var response = await client.GetAsync("/health/live");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("Healthy", await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Readiness_is_unhealthy_when_database_is_unreachable()
    {
        await using var factory = CreateFactory(UnreachableDatabase);
        using var client = factory.CreateClient();

        var response = await client.GetAsync("/health/ready");

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Equal("Unhealthy", await response.Content.ReadAsStringAsync());
    }

    private static WebApplicationFactory<Program> CreateFactory(string connectionString) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.UseSetting("ConnectionStrings:Chain", connectionString));
}
