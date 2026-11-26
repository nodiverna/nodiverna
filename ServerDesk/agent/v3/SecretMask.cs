using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace ServerDesk.Agent;

internal static partial class SecretMask
{
    internal const string Redacted = "[redacted]";

    internal static string Apply(string text, IEnumerable<string> secrets)
    {
        var variants = new HashSet<string>(StringComparer.Ordinal);
        foreach (string secret in secrets.Where(s => !string.IsNullOrEmpty(s)))
        {
            variants.Add(secret);
            foreach (var encoder in new[] { JavaScriptEncoder.Default, JavaScriptEncoder.UnsafeRelaxedJsonEscaping }) { string escaped = JsonValue.Create(secret)!.ToJsonString(new JsonSerializerOptions { Encoder = encoder }); if (escaped.Length >= 2) variants.Add(escaped[1..^1]); }
        }
        foreach (string value in variants.OrderByDescending(s => s.Length)) text = text.Replace(value, Redacted, StringComparison.Ordinal); return text;
    }

    /// <summary>
    /// A command line without secrets (autostart entries, docs/v3-health-signals.md):
    /// the agent's known secrets as in <see cref="Apply"/>, then the values of the
    /// credential arguments -password, -passwd, -passphrase, -pwd, -pass, -token,
    /// -access-token, -apikey/-api-key, -client-secret, -secret and -credential
    /// (with -, -- or /, separated by space, = or :), the plain-text string of
    /// ConvertTo-SecureString, password= and pwd= in connection strings (a quoted
    /// value whole, also with backslash-escaped quotes; an unquoted one up to the next
    /// ; or closing quote), the value after
    /// "Bearer", and the password of a URL's user info (://user:pass@ →
    /// ://user:[redacted]@, also with an empty user name).
    /// </summary>
    internal static string CommandLine(string text, IEnumerable<string> knownSecrets)
    {
        string masked = Apply(text, knownSecrets);
        masked = CredentialArgument().Replace(masked, match => match.Groups["prefix"].Value + Redacted);
        masked = SecureString().Replace(masked, match => match.Groups["prefix"].Value + Redacted);
        masked = ConnectionString().Replace(masked, match => match.Groups["prefix"].Value + Redacted);
        masked = Bearer().Replace(masked, match => match.Groups["prefix"].Value + Redacted);
        masked = UrlUserInfo().Replace(masked, match => match.Groups["prefix"].Value + Redacted + "@");
        return masked;
    }

    // The argument name must end at a separator, so -passthru or /p: stay as they are.
    // A value is \"…\" (backslash-escaped quotes, as in powershell -Command "… \"x\""),
    // "…", '…', or unquoted: up to whitespace; a quote inside (S3c'ret) does not end it
    // unless whitespace or the end of the text follows.
    [GeneratedRegex(@"(?<prefix>(?:^|(?<=[\s""']))(?:--|-|/)(?:password|passwd|passphrase|pwd|pass|access[-_]?token|token|api[-_]?key|client[-_]?secret|secret|credential)(?:\s*[=:]\s*|\s+))(?<value>\\""(?:[^""\\]|\\.)*?\\""|""[^""]*""|'[^']*'|[^\s""'](?:[^\s""']|[""'](?!\s|$))*)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex CredentialArgument();
    [GeneratedRegex(@"(?<prefix>\bConvertTo-SecureString\s+(?:-String\s+)?)(?<value>\\?""[^""]*""|'[^']*'|[^\s""']+)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex SecureString();
    // Connection-string values may be quoted (\"…\", or "…"/'…' where "" and '' escape a
    // quote inside) and may contain spaces. An unquoted value runs to the next ; or to a
    // quote that whitespace, ; or the end of the text follows, so O'Brien1 is masked whole.
    [GeneratedRegex(@"(?<prefix>(?:^|(?<=[;\s""']))(?:password|pwd)\s*=\s*)(?<value>\\""(?:[^""\\]|\\.)*?\\""|""(?:[^""]|"""")*""|'(?:[^']|'')*'|[^;""'](?:[^;""']|[""'](?![\s;]|$))*)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ConnectionString();
    [GeneratedRegex(@"(?<prefix>\bBearer\s+)(?<value>[^\s""']+)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Bearer();
    [GeneratedRegex(@"(?<prefix>://[^/\s:@""']*:)(?<value>[^@\s/""']+)@", RegexOptions.CultureInvariant)]
    private static partial Regex UrlUserInfo();
}
