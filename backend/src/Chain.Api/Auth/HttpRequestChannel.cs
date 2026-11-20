using System.Security.Claims;
using Chain.SharedKernel;

namespace Chain.Api.Auth;

/// <summary>
/// The channel of the current HTTP request, read from the <c>chain:channel</c> claim its authentication scheme set
/// (workflow-engine.md §8, card #83). Outside a request, and for the automation result call, there is none.
/// </summary>
internal sealed class HttpRequestChannel(IHttpContextAccessor http) : IRequestChannel
{
    public RequestChannel? Current => http.HttpContext?.User.FindFirstValue(CallerClaims.ChannelClaim) switch
    {
        CallerClaims.UiChannel => RequestChannel.Ui,
        CallerClaims.ApiChannel => RequestChannel.Api,
        CallerClaims.McpChannel => RequestChannel.Mcp,
        _ => null,
    };
}
