using Chain.Identity.Application;
using Microsoft.AspNetCore.Identity;

namespace Chain.Infrastructure.Identity;

/// <summary>ASP.NET Core Identity's PBKDF2 password hasher (salted, versioned format; ADR-0006 §4).</summary>
internal sealed class AspNetPasswordHasher : Chain.Identity.Application.IPasswordHasher
{
    private static readonly object Subject = new();
    private readonly PasswordHasher<object> _inner = new();

    public string Hash(string password) => _inner.HashPassword(Subject, password);

    public PasswordCheck Verify(string hash, string password) => _inner.VerifyHashedPassword(Subject, hash, password) switch
    {
        PasswordVerificationResult.Success => PasswordCheck.Success,
        PasswordVerificationResult.SuccessRehashNeeded => PasswordCheck.SuccessRehashNeeded,
        _ => PasswordCheck.Failed,
    };
}
