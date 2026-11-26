using System.Text.RegularExpressions;

namespace ServerDesk.Agent;

/// <summary>
/// The version form of agent releases, the same rule as runtime/release-version.mjs
/// of the portal: X.Y.Z without leading zeros, or a dev build X.Y.Z-dev.&lt;sha7&gt;
/// from the dev branch (the first 7 lowercase hex characters of the commit). The
/// rank compares the base X.Y.Z numerically; for the same base a release ranks
/// above any dev build, and two dev builds of the same base have the same rank.
/// </summary>
internal static class ReleaseVersion
{
    private static readonly Regex Pattern = new(@"^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(-dev\.[0-9a-f]{7})?\z", RegexOptions.CultureInvariant);

    /// <summary>The base X.Y.Z and whether the value is a dev build; false for any other value.</summary>
    internal static bool TryParse(string? value, out Version baseVersion, out bool dev)
    {
        baseVersion = new Version(0, 0, 0); dev = false;
        if (value is null) return false;
        var match = Pattern.Match(value);
        if (!match.Success) return false;
        baseVersion = new Version(int.Parse(match.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture), int.Parse(match.Groups[2].Value, System.Globalization.CultureInfo.InvariantCulture), int.Parse(match.Groups[3].Value, System.Globalization.CultureInfo.InvariantCulture));
        dev = match.Groups[4].Success;
        return true;
    }

    internal static bool IsValid(string? value) => TryParse(value, out _, out _);

    /// <summary>The base X.Y.Z of a valid version; InvalidDataException for any other value.</summary>
    internal static Version Base(string value) => TryParse(value, out var baseVersion, out _) ? baseVersion : throw new InvalidDataException("Invalid release version");

    /// <summary>-1, 0 or 1 by rank; InvalidDataException when one side is not a valid version.</summary>
    internal static int CompareRank(string left, string right)
    {
        if (!TryParse(left, out var a, out bool devLeft) || !TryParse(right, out var b, out bool devRight)) throw new InvalidDataException("Invalid release version");
        int byBase = a.CompareTo(b);
        if (byBase != 0) return Math.Sign(byBase);
        return devLeft == devRight ? 0 : devLeft ? -1 : 1;
    }
}
