using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace ServerDesk.Agent;

// A job result message the agent writes itself: a stable code, its arguments
// and the English fallback text. The portal shows its catalog text
// agentMessage.<code> in the user's language and falls back to Text.
internal sealed record AgentMessage(string Code, IReadOnlyDictionary<string, string> Args)
{
    internal string Text => AgentMessages.Format(Code, Args);
}

// The agent's own failure in a job. Message is the English text with the
// arguments filled in. OS, WMI and IO exceptions stay raw and carry no code.
internal sealed class AgentMessageException : InvalidOperationException
{
    internal string Code { get; }
    internal IReadOnlyDictionary<string, string> Args { get; }
    internal AgentMessageException(string code, params (string Name, object? Value)[] args) : this(AgentMessages.Of(code, args), null) { }
    internal AgentMessageException(Exception inner, string code, params (string Name, object? Value)[] args) : this(AgentMessages.Of(code, args), inner) { }
    private AgentMessageException(AgentMessage message, Exception? inner) : base(message.Text, inner) { Code = message.Code; Args = message.Args; }
    internal AgentMessage ToMessage() => new(Code, Args);
}

// The only registry of agent message codes. Each entry is one line,
// Define("AGENT_CODE", "English template.") or, with a {count} plural,
// Define("AGENT_CODE", "One form.", "Other form."). tests/agent/agent-messages.mjs
// parses these lines and requires the same entries in the portal catalogs.
internal static class AgentMessages
{
    internal const int MaxMessage = 3500, MaxArgs = 8, MaxArgValue = 1000;
    // AGENT_ for the agent's own messages; PLUGIN_ for the messages of an agent plugin (docs/agent-plugins.md).
    private static readonly Regex CodePattern = new("^(AGENT|PLUGIN)_[A-Z0-9_]{1,60}$", RegexOptions.CultureInvariant);
    private static readonly Regex PluginCodePattern = new("^PLUGIN_[A-Z0-9_]{1,60}$", RegexOptions.CultureInvariant);
    private static readonly Regex NamePattern = new("^[a-z][A-Za-z0-9]{0,31}$", RegexOptions.CultureInvariant);
    private static readonly Regex Placeholder = new(@"\{([a-z][A-Za-z0-9]{0,31})\}", RegexOptions.CultureInvariant);
    private static readonly Dictionary<string, (string One, string Other)> templates = new(StringComparer.Ordinal);
    internal static IReadOnlyDictionary<string, (string One, string Other)> Templates => templates;

    private static void Define(string code, string template, string? other = null)
    {
        if (!CodePattern.IsMatch(code) || !templates.TryAdd(code, (template, other ?? template))) throw new InvalidOperationException("Invalid or duplicate agent message code: " + code);
    }

    internal static AgentMessage Of(string code, params (string Name, object? Value)[] args)
    {
        if (!templates.ContainsKey(code)) throw new InvalidOperationException("Unknown agent message code: " + code);
        if (args.Length > MaxArgs) throw new InvalidOperationException("Too many arguments for agent message " + code);
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (name, value) in args)
        {
            if (!NamePattern.IsMatch(name) || values.ContainsKey(name)) throw new InvalidOperationException("Invalid argument name for agent message " + code + ": " + name);
            values[name] = Limit(Convert.ToString(value, CultureInfo.InvariantCulture) ?? "", MaxArgValue);
        }
        return new(code, values);
    }

    internal static string Format(string code, IReadOnlyDictionary<string, string> args)
    {
        var (one, other) = templates[code];
        string template = args.TryGetValue("count", out string? count) && count == "1" ? one : other;
        return Placeholder.Replace(template, match => args.TryGetValue(match.Groups[1].Value, out string? value) ? value : match.Value);
    }

    // Writes code, args and the English fallback into a job result. Secret
    // masking covers every argument value as well as the message.
    internal static JsonObject Write(JsonObject result, AgentMessage message, IReadOnlyCollection<string>? secrets = null)
    {
        var args = message.Args.ToDictionary(pair => pair.Key, pair => secrets is null ? pair.Value : SecretMask.Apply(pair.Value, secrets), StringComparer.Ordinal);
        string text = Format(message.Code, args); if (secrets is not null) text = SecretMask.Apply(text, secrets);
        result["message"] = Limit(text, MaxMessage); result["code"] = message.Code;
        if (args.Count > 0) { var box = new JsonObject(); foreach (var pair in args) box[pair.Key] = pair.Value; result["args"] = box; } else result.Remove("args");
        return result;
    }

    internal static JsonObject Write(JsonObject result, string code, params (string Name, object? Value)[] args) => Write(result, Of(code, args));

    /// <summary>
    /// The result of a plugin operation: the plugin's PLUGIN_* code and arguments
    /// pass through unchanged. The message is the registered English template
    /// when the code is known and every placeholder has a value, else the
    /// plugin's own text with control characters removed.
    /// </summary>
    internal static JsonObject WritePlugin(JsonObject result, string code, IReadOnlyDictionary<string, string> args, string message)
    {
        if (!PluginCodePattern.IsMatch(code) || args.Count > MaxArgs || args.Any(pair => !NamePattern.IsMatch(pair.Key))) throw new AgentMessageException("AGENT_PLUGIN_OUTPUT_INVALID");
        var values = args.ToDictionary(pair => pair.Key, pair => Limit(pair.Value, MaxArgValue), StringComparer.Ordinal);
        string text = templates.TryGetValue(code, out var template) && Placeholders(template.One + " " + template.Other).All(values.ContainsKey) ? Format(code, values) : new string(message.Select(c => char.IsControl(c) ? ' ' : c).ToArray());
        result["message"] = Limit(text, MaxMessage); result["code"] = code;
        if (values.Count > 0) { var box = new JsonObject(); foreach (var pair in values) box[pair.Key] = pair.Value; result["args"] = box; } else result.Remove("args");
        return result;
    }

    // The failure of a job. An agent message keeps its code; an OS, WMI or IO
    // exception text passes through unchanged, without a code.
    internal static JsonObject Fail(JsonObject result, Exception error, IReadOnlyCollection<string>? secrets = null, int limit = MaxMessage)
    {
        if (error is OperationCanceledException) return Write(result, Of("AGENT_JOB_CANCELLED"), secrets);
        if (error is AgentMessageException coded) { Write(result, coded.ToMessage(), secrets); result["message"] = Limit(result["message"]!.GetValue<string>(), limit); return result; }
        string text = secrets is null ? error.Message : SecretMask.Apply(error.Message, secrets);
        result["message"] = Limit(text, Math.Min(limit, MaxMessage)); result.Remove("code"); result.Remove("args");
        return result;
    }

    internal static IReadOnlyList<string> Placeholders(string template) => Placeholder.Matches(template).Select(match => match.Groups[1].Value).Distinct(StringComparer.Ordinal).ToArray();
    private static string Limit(string value, int maximum) => value.Length <= maximum ? value : value[..maximum];

    static AgentMessages()
    {
        // agent-messages:start
        Define("AGENT_JOB_INTERRUPTED", "The agent restarted during this job and did not run it again. Check the device before you start a new job.");
        Define("AGENT_UPDATE_BUSY", "The agent can update only when no terminal session, file transfer or job is running. Nothing was updated.");
        Define("AGENT_UNINSTALL_STARTED", "The agent started to uninstall itself. The device can no longer connect to the portal.");
        Define("AGENT_UNINSTALL_BUSY", "The agent can uninstall itself only when no terminal session, file transfer or job is running. Nothing was uninstalled.");
        Define("AGENT_UNINSTALL_NOT_ADMIN", "The agent does not run with administrator rights. Nothing was uninstalled.");
        Define("AGENT_UNINSTALL_SERVICE_REQUIRED", "The agent can uninstall itself only when it runs as the installed ServerDesk service. Nothing was uninstalled.");
        Define("AGENT_UNINSTALL_MAINTENANCE", "A local installation or maintenance is in progress. Try again when it is complete.");
        Define("AGENT_UNINSTALL_UPDATE_PENDING", "An agent update is pending. Try again when the update is complete.");
        Define("AGENT_UNINSTALL_JOB_ACTIVE", "Another job is running on the device. Try again when it is complete.");
        Define("AGENT_UNINSTALL_TERMINAL_ACTIVE", "A terminal or Remote Desktop session is open. Close it and try again.");
        Define("AGENT_UNINSTALL_TRANSFER_ACTIVE", "A file transfer is in progress. Try again when it is complete.");
        Define("AGENT_UNINSTALL_STAGE_FAILED", "The uninstaller could not be prepared: {detail}. Nothing was uninstalled.");
        Define("AGENT_BUSY", "The device is running another job or file transfer, or it is preparing an agent update. Nothing was run. Try again later.");
        Define("AGENT_READONLY", "The agent on this device runs in Read-only mode. Turn on Management mode on the device itself and try again.");
        Define("AGENT_UPDATE_RELAY_REQUIRED", "The agent could not prepare the update. Try again. If it fails again, check the agent log on the device.");
        Define("AGENT_UNKNOWN_ACTION", "The agent does not know this action and did not run it. Update the agent and try again.");
        Define("AGENT_JOB_CANCELLED", "The job ran out of time or the agent service stopped. The job does not run again by itself. Check the device for changes that were only partly made.");
        Define("AGENT_RUNBOOK_DIAGNOSIS_UNTRUSTED", "This diagnostics action cannot run in Read-only mode.");
        Define("AGENT_RUNBOOK_MANAGEMENT_REQUIRED", "PowerShell steps run only in Management mode. Turn on Management mode on the device and try again.");
        Define("AGENT_RUNBOOK_STEP_COMPLETED", "Runbook step completed.");
        Define("AGENT_RUNBOOK_FAILED", "Runbook failed: {detail}");
        Define("AGENT_ASSISTANT_SCRIPT_COMPLETED", "Script completed.");
        Define("AGENT_ASSISTANT_SCRIPT_FAILED", "Script failed: {detail}");
        Define("AGENT_ASSISTANT_MANAGEMENT_REQUIRED", "The agent runs scripts only in Management mode. Switch the agent to Management mode, then run the script again.");
        Define("AGENT_FILE_OPERATION_COMPLETED", "File operation completed.");
        Define("AGENT_FILE_FOLDER_CREATED", "Folder created.");
        Define("AGENT_FILE_ENTRY_RENAMED", "Entry renamed.");
        Define("AGENT_FILE_ENTRY_DELETED", "Entry deleted.");
        Define("AGENT_FILE_INVALID_PATH", "The path is not a valid local Windows path.");
        Define("AGENT_FILE_PATH_PROTECTED", "This path or name is protected.");
        Define("AGENT_FILE_REPARSE_POINT", "The agent does not open junctions, symbolic links or other reparse points.");
        Define("AGENT_FILE_PATH_MISMATCH", "The path leads to a different place than requested, so the agent did not open it.");
        Define("AGENT_FILE_UNKNOWN_ACTION", "The agent does not know this file action. Update the agent and try again.");
        Define("AGENT_FILE_MANAGEMENT_REQUIRED", "The agent changes files only in Management mode. Turn on Management mode on the device and try again.");
        Define("AGENT_FILE_ROOT_PROTECTED", "You cannot change a drive root or a folder that contains the agent data.");
        Define("AGENT_FILE_FOLDER_NOT_FOUND", "The folder does not exist. Refresh the folder list.");
        Define("AGENT_FILE_ENTRY_EXISTS", "An entry with this name already exists.");
        Define("AGENT_FILE_INVALID_NAME", "The new name is not valid. Remove characters that Windows does not allow in names.");
        Define("AGENT_FILE_TARGET_EXISTS", "An entry with the target name already exists. Nothing was overwritten.");
        Define("AGENT_FILE_DELETE_FAILED", "The entry could not be deleted. A folder must be empty, and files that are open or protected stay.");
        Define("AGENT_STORAGE_MANAGEMENT_REQUIRED", "The agent changes disks only in Management mode. Turn on Management mode on the device and try again.");
        Define("AGENT_STORAGE_INVENTORY_TOO_LARGE", "The disk inventory is too large to send to the portal.");
        Define("AGENT_STORAGE_UNKNOWN_ACTION", "The agent does not know this disk action. Update the agent and try again.");
        Define("AGENT_STORAGE_NOT_CONFIRMED", "The disk change was not confirmed. Confirm it and try again.");
        Define("AGENT_STORAGE_PARTITION_STYLE", "Choose GPT or MBR.");
        Define("AGENT_STORAGE_INVALID_STATE", "The requested disk state is not valid.");
        Define("AGENT_STORAGE_FILE_SYSTEM", "Choose NTFS or ReFS.");
        Define("AGENT_STORAGE_INVALID_LABEL", "The volume label is not valid.");
        Define("AGENT_STORAGE_DRIVE_LETTER", "Choose a free drive letter from D to Z.");
        Define("AGENT_STORAGE_SIZE_CONFLICT", "Enter either a size or the maximum size, not both.");
        Define("AGENT_STORAGE_LETTER_OR_REMOVE", "Enter a drive letter or remove it.");
        Define("AGENT_STORAGE_INVENTORY_COLLECTED", "Disk inventory collected.");
        Define("AGENT_STORAGE_DISK_NOT_UNIQUE", "The agent cannot identify the disk clearly. Refresh the disk inventory and try again.");
        Define("AGENT_STORAGE_DISK_CHANGED", "The ID or size of the disk changed. Refresh the disk inventory and check the change again.");
        Define("AGENT_STORAGE_PARTITION_NOT_UNIQUE", "The agent cannot identify the partition clearly. Refresh the disk inventory and try again.");
        Define("AGENT_STORAGE_PARTITION_CHANGED", "The partition changed in the meantime. Refresh the disk inventory and try again.");
        Define("AGENT_STORAGE_PARTITION_PROTECTED", "The partition is protected: {reasons}");
        Define("AGENT_STORAGE_DISK_PROTECTED", "The disk is protected: {reasons}");
        Define("AGENT_STORAGE_DISK_STATE_CHANGED", "Disk state changed.");
        Define("AGENT_STORAGE_DISK_NOT_WRITABLE", "The disk must be online and writable.");
        Define("AGENT_STORAGE_DISK_UNHEALTHY", "The disk reports an error, so the agent did not change it.");
        Define("AGENT_STORAGE_INIT_ONLY_RAW", "Only an uninitialized disk without partitions can be initialized.");
        Define("AGENT_STORAGE_GPT_REQUIRED", "A disk larger than 2 TiB needs GPT. Choose GPT.");
        Define("AGENT_STORAGE_INITIALIZED", "Disk initialized.");
        Define("AGENT_STORAGE_INITIALIZE_FIRST", "Initialize the disk first.");
        Define("AGENT_STORAGE_SIZE_EXCEEDS_FREE", "The size is larger than the free space in one piece on the disk. Choose a smaller size.");
        Define("AGENT_STORAGE_DISK_CHANGED_DURING_CREATE", "The disk changed while the partition was being created. Check the disk inventory.");
        Define("AGENT_STORAGE_NEW_PARTITION_UNKNOWN", "The partition was created, but the agent could not find it to format it. Check the disk inventory.");
        Define("AGENT_STORAGE_FORMAT_FAILED", "The partition was created, but formatting failed: {detail} Check the disk inventory before you start a new job.");
        Define("AGENT_STORAGE_VOLUME_CREATED", "Partition created and volume formatted.");
        Define("AGENT_STORAGE_RESIZE_FILE_SYSTEM", "Only NTFS or ReFS volumes can be resized.");
        Define("AGENT_STORAGE_RESIZE_RANGE", "The size is outside the limits that Windows currently supports.");
        Define("AGENT_STORAGE_RESIZED", "Volume size changed.");
        Define("AGENT_STORAGE_NO_DRIVE_LETTER", "The partition has no drive letter.");
        Define("AGENT_STORAGE_DRIVE_LETTER_CHANGED", "Drive letter changed.");
        Define("AGENT_STORAGE_VOLUME_NOT_UNIQUE", "The agent cannot identify the volume clearly. Refresh the disk inventory and try again.");
        Define("AGENT_STORAGE_FORMATTED", "Data volume formatted. Previous data was deleted.");
        Define("AGENT_STORAGE_PARTITION_DELETED", "Data partition deleted.");
        Define("AGENT_STORAGE_LETTER_IN_USE", "The drive letter is already in use.");
        Define("AGENT_STORAGE_OBJECT_PATH_MISSING", "Windows did not return the path of the storage object.");
        Define("AGENT_STORAGE_NO_STATUS", "Windows did not report whether the disk change succeeded. Check the disk inventory.");
        Define("AGENT_STORAGE_METHOD_FAILED", "Windows Storage {method} failed (code {status}). {detail}");
        Define("AGENT_STORAGE_SIZE_UNSAFE", "The disk is larger than the agent can handle safely.");
        Define("AGENT_UNKNOWN_PARAMETER", "The job contains an unknown parameter: {name}");
        Define("AGENT_NUMBER_MISSING", "A number is missing in the job: {name}");
        Define("AGENT_INVALID_NUMBER", "A number in the job is not valid: {name}");
        Define("AGENT_NUMBER_OUT_OF_RANGE", "A number in the job is outside the allowed range: {name}");
        Define("AGENT_TEXT_MISSING", "A text is missing in the job: {name}");
        Define("AGENT_INVALID_TEXT_PARAMETER", "A text in the job is not valid: {name}");
        Define("AGENT_BOOLEAN_MISSING", "A yes or no value is missing in the job: {name}");
        Define("AGENT_INVALID_BOOLEAN", "A yes or no value in the job is not valid: {name}");
        Define("AGENT_INVALID_TIMESTAMP", "A time in the job is not valid.");
        Define("AGENT_INVALID_COUNT", "The number of entries in the job is not valid: {name}");
        Define("AGENT_INVALID_LIST_ENTRY", "A list entry in the job is not valid: {name}");
        Define("AGENT_INVALID_CHOICE", "A choice in the job is not valid: {name}");
        Define("AGENT_PARAMETERS_TOO_LARGE", "The input of the job is too large.");
        Define("AGENT_CHANGE_NOT_CONFIRMED", "The change was not confirmed. Confirm it and try again.");
        Define("AGENT_UNKNOWN_DIAGNOSTIC_ACTION", "The agent does not know this diagnostics action. Update the agent and try again.");
        Define("AGENT_DIAGNOSTIC_COMPLETED", "Diagnostic action completed.");
        Define("AGENT_DIAGNOSTIC_OUTPUT_TOO_LARGE", "The result is too large. Narrow the filter or ask for fewer rows.");
        Define("AGENT_PROCESS_LIST_UNAVAILABLE", "The process list could not be read. Try again.");
        Define("AGENT_PID_REUSED", "The process ended, and Windows gave its ID to another process. Refresh the process list.");
        Define("AGENT_PROCESS_PROTECTED", "This is a critical Windows or agent process. The agent does not end it.");
        Define("AGENT_PROCESS_ENDED", "Process ended.");
        Define("AGENT_PROCESS_END_REQUESTED", "Windows was asked to end the process, but the process is still running. Refresh the process list in a moment.");
        Define("AGENT_SESSION_CHANGED", "The user session changed in the meantime. Refresh the sessions.");
        Define("AGENT_SESSION_ACTION_SUBMITTED", "Windows received the session action.");
        Define("AGENT_INVALID_EVENT_CHANNEL", "The event log is not valid.");
        Define("AGENT_EVENT_RANGE", "The start must be before the end.");
        Define("AGENT_INVALID_EVENT_PROVIDER", "The event source is not valid.");
        Define("AGENT_INVALID_CURSOR", "The position in the event log is not valid. Load the events again.");
        Define("AGENT_EVENT_CURSOR_INVALID_CHANNEL", "The position belongs to another event log. Load the events again.");
        Define("AGENT_EVENT_CURSOR_INVALID", "The event log was cleared or overwritten in the meantime. Load the events again.");
        Define("AGENT_INVALID_EVENT_FILTER_LIST", "The event filter is not valid.");
        Define("AGENT_INVALID_EXPORT_FORMAT", "The export format is not valid.");
        Define("AGENT_EVENT_FILTER_MISSING", "The event filter is missing.");
        Define("AGENT_EVTX_NO_TEXT_FILTER", "The EVTX export cannot use a text filter. Choose JSON or CSV, or remove the text filter.");
        Define("AGENT_EVENTS_NONE_FOR_EXPORT", "No events match the export filter.");
        Define("AGENT_INVALID_EVENT_CHANNELS", "The event logs are not valid.");
        Define("AGENT_EVENT_CHANNEL_COUNT", "Choose 1 to 3 event logs.");
        Define("AGENT_EXPORT_FOLDER_REPARSE", "The export folder is a link to another place. The agent does not write to it.");
        Define("AGENT_SUPPORT_EXPORT_TOO_LARGE", "The support bundle is larger than 100 MiB. Choose fewer event logs.");
        Define("AGENT_CONNECTION_TABLE_TOO_LARGE", "The device has too many network connections to list.");
        Define("AGENT_CONNECTION_TABLE_INVALID", "Windows returned an incomplete list of connections. Try again.");
        Define("AGENT_CONNECTION_TABLE_CHANGED", "The connections changed while the agent read them. Try again.");
        Define("AGENT_INVALID_JOB_ID", "The job ID is not valid.");
        Define("AGENT_WINDOWS_REQUIRED", "This action needs Windows Server 2022, Windows Server 2025 or Windows 11.");
        Define("AGENT_KEY_MISSING", "The agent cannot open the secrets of this job because its key is missing.");
        Define("AGENT_INVENTORY_REFRESH_REQUESTED", "Inventory refresh requested.");
        Define("AGENT_TCP_CONNECTED", "TCP connection succeeded: {host}:{port}");
        Define("AGENT_FEATURE_CHANGED_REBOOT", "Role or feature changed. Restart the device to finish the change. The agent did not restart it.");
        Define("AGENT_FEATURE_CHANGED", "Role or feature changed. No restart is required.");
        Define("AGENT_FEATURE_CHANGE_FAILED", "The role or feature change failed: {detail}");
        Define("AGENT_SERVICE_ACTION_DONE", "Service action completed.");
        Define("AGENT_NETWORK_CHANGED", "IPv4 configuration changed. Set DNS separately. The connection to the portal may drop for a moment.");
        Define("AGENT_DNS_CHANGED", "DNS configuration changed. The connection to the portal may drop for a moment.");
        Define("AGENT_COMPUTER_CHANGE_PENDING", "The computer change is ready. Restart the device to apply it. The agent did not restart it.");
        Define("AGENT_PAGEFILE_CHANGED", "Page file changed. The new sizes apply after you restart the device. Other drives are unchanged.");
        Define("AGENT_POWER_SCHEDULED", "The restart or shutdown starts in {seconds} seconds. To cancel it on the device, run shutdown.exe /a.");
        Define("AGENT_FIREWALL_RULE_CREATED", "Local firewall rule created.");
        Define("AGENT_FIREWALL_RULE_CHANGED", "Local firewall rule changed. Rules from group policies still apply and can override it.");
        Define("AGENT_TASK_CHANGED", "Scheduled task changed.");
        Define("AGENT_RDP_DISABLE_CONFIRM", "Confirm that you want to turn off Remote Desktop.");
        Define("AGENT_INVALID_NETWORK_TARGET", "The network target is not valid.");
        Define("AGENT_SERVICE_SELF_PROTECTED", "You cannot stop, restart or disable the agent service here. To update the agent, start an agent update.");
        Define("AGENT_INVALID_FEATURE_NAME", "The name of the role or feature is not valid.");
        Define("AGENT_INVALID_DOMAIN", "The domain name is not valid.");
        Define("AGENT_INVALID_WORKGROUP", "The workgroup name is not valid.");
        Define("AGENT_INVALID_COMPUTER_NAME", "The computer name is not valid.");
        Define("AGENT_PAGEFILE_DRIVE_FORMAT", "Enter the drive in the format C:.");
        Define("AGENT_PAGEFILE_SIZE_ORDER", "The maximum size must be at least the initial size.");
        Define("AGENT_INVALID_GROUP_SID", "The group SID is not valid.");
        Define("AGENT_FIREWALL_PORT_FORMAT", "Enter the ports as a number, a range or a comma-separated list.");
        Define("AGENT_INVALID_PORT_RANGE", "The port range is not valid.");
        Define("AGENT_INVALID_ADDRESS_PREFIX", "The address prefix is not valid.");
        Define("AGENT_INVALID_TASK_PATH", "The task path is not valid.");
        Define("AGENT_TASK_POWER_PROTECTED", "This task belongs to a restart or shutdown that Nodiverna scheduled. Change it under Scheduled maintenance in the System area of the device.");
        Define("AGENT_TASK_RECOVERY_PROTECTED", "This task restores the agent after a failed update. You cannot change it here.");
        Define("AGENT_WILDCARDS_NOT_ALLOWED", "Wildcards are not allowed.");
        Define("AGENT_INVALID_LOCAL_USERNAME", "The local user name is not valid.");
        Define("AGENT_INVALID_IP", "The IP address is not valid.");
        Define("AGENT_NO_UNICAST_ADDRESS", "Enter an IP address that can be assigned to a network adapter.");
        Define("AGENT_GATEWAY_SUBNET", "The default gateway must be another unicast address in the same subnet.");
        Define("AGENT_COMPUTER_INVENTORY_UNAVAILABLE", "The agent could not read the computer information. Try again.");
        Define("AGENT_OS_INVENTORY_UNAVAILABLE", "The agent could not read the operating system information. Try again.");
        Define("AGENT_DOMAIN_CONTROLLER", "This device is a domain controller. Change it with the Active Directory tools on the server.");
        Define("AGENT_IPV4_ADAPTER_NOT_FOUND", "The agent cannot find the IPv4 network adapter. Refresh the inventory.");
        Define("AGENT_IPV4_ROUTE_RESTORE_FAILED", "The agent could not restore the IPv4 route. Windows code: {status}");
        Define("AGENT_IPV4_ADDRESS_FAILED", "The agent could not set the IPv4 address. Windows code: {status}");
        Define("AGENT_DNS_CONFIGURE_FAILED", "The agent could not set the DNS servers. Windows code: {status}");
        Define("AGENT_IP_CHANGE_RESTORE_FAILED", "The IP change failed, and the agent could not restore the previous settings. Fix the network settings in the VM console. Original error: {detail}");
        Define("AGENT_IP_CHANGE_RESTORED", "The IP change failed. The agent restored the previous settings: {detail}");
        Define("AGENT_NETWORK_ADAPTER_NOT_FOUND", "The agent cannot find the network adapter. Refresh the inventory.");
        Define("AGENT_LOCAL_DRIVE_NOT_FOUND", "The local drive does not exist.");
        Define("AGENT_PAGEFILE_NO_SPACE", "The drive does not have enough free space for the initial size of the page file.");
        Define("AGENT_FIREWALL_AMBIGUOUS_NAME", "Several firewall rules have this display name. Give the rule a unique name.");
        Define("AGENT_WINDOWS_COMPONENT_MISSING", "A Windows component is missing: {component}");
        Define("AGENT_FIREWALL_RULE_NOT_FOUND", "The agent cannot find exactly one local firewall rule with this name. It does not change rules from group policies.");
        Define("AGENT_WMI_PATH_MISSING", "Windows did not return the path of the WMI object.");
        Define("AGENT_WINDOWS_INSTANCE_FAILED", "Windows could not create the object.");
        Define("AGENT_SERVICE_TIMEOUT", "The service did not reach the requested state within 60 seconds. Check the service on the device.");
        Define("AGENT_USER_CREATED", "Local user created. Add group memberships in a separate step.");
        Define("AGENT_USER_UPDATED", "Local user updated.");
        Define("AGENT_PASSWORD_CHANGED", "Local password changed.");
        Define("AGENT_USER_BUILTIN_PROTECTED", "The agent does not delete built-in Windows accounts.");
        Define("AGENT_USER_DELETED", "Local user deleted. Existing profile folders were not removed.");
        Define("AGENT_GROUP_MEMBERSHIP_CHANGED", "Local group membership changed.");
        Define("AGENT_UNKNOWN_USER_ACTION", "The agent does not know this action for local users. Update the agent and try again.");
        Define("AGENT_USERNAME_AMBIGUOUS", "Several accounts on the device have this user name.");
        Define("AGENT_USER_INVENTORY_TOO_LARGE", "The device has too many local users for the agent to check the administrators safely.");
        Define("AGENT_GROUP_INVENTORY_TOO_LARGE", "The device has too many local groups for the agent to check the administrators safely.");
        Define("AGENT_LAST_ADMIN", "You cannot remove or disable the last enabled local administrator.");
        Define("AGENT_LOCAL_GROUP_NOT_FOUND", "The local group does not exist.");
        Define("AGENT_LOCAL_GROUP_ONLY", "You can manage only local groups here.");
        Define("AGENT_DOMAIN_LEAVE_FIRST", "Leave the current domain first, then restart and join the new domain.");
        Define("AGENT_NOT_DOMAIN_MEMBER", "The server is not a domain member.");
        Define("AGENT_WORKGROUP_FAILED", "The device left the domain, but the agent could not set the workgroup. Set it in the VM console and restart the device. {detail}");
        Define("AGENT_COMPUTER_RENAME_FAILED", "The computer name could not be changed.");
        Define("AGENT_SHUTDOWN_PRIVILEGE_MISSING", "The agent does not have the Windows privilege to restart the device.");
        Define("AGENT_POWER_SCHEDULE_FAILED", "Windows could not schedule the power action.");
        Define("AGENT_USER_CREATE_FAILED", "Creating the local user failed. Windows code: {status}");
        Define("AGENT_USER_CREATE_FAILED_PARAMETER", "Creating the local user failed. Windows code: {status}; parameter: {parameter}");
        Define("AGENT_USER_DELETE_FAILED", "Deleting the local user failed. Windows code: {status}");
        Define("AGENT_GROUP_MEMBERSHIP_FAILED", "Changing the local group membership failed. Windows code: {status}");
        Define("AGENT_USER_READ_FAILED", "Reading the local user failed. Windows code: {status}");
        Define("AGENT_USERS_READ_FAILED", "Reading the local users failed. Windows code: {status}");
        Define("AGENT_ADMINS_READ_FAILED", "Reading the local administrators failed. Windows code: {status}");
        Define("AGENT_GROUP_CHECK_FAILED", "Checking the local group failed. Windows code: {status}");
        Define("AGENT_USER_UPDATE_FAILED", "Updating the local user failed. Windows code: {status}");
        Define("AGENT_USER_UPDATE_FAILED_PARAMETER", "Updating the local user failed. Windows code: {status}; parameter: {parameter}");
        Define("AGENT_ACCOUNT_STATUS_FAILED", "Updating the account status failed. Windows code: {status}");
        Define("AGENT_ACCOUNT_STATUS_FAILED_PARAMETER", "Updating the account status failed. Windows code: {status}; parameter: {parameter}");
        Define("AGENT_DOMAIN_JOIN_FAILED", "Joining the domain failed. Windows code: {status}");
        Define("AGENT_DOMAIN_LEAVE_FAILED", "Leaving the domain failed. Windows code: {status}");
        Define("AGENT_WORKGROUP_SET_FAILED", "Setting the workgroup failed. Windows code: {status}");
        Define("AGENT_DOMAIN_RENAME_FAILED", "Renaming the domain computer failed. Windows code: {status}");
        Define("AGENT_FEATURE_NOT_FOUND", "Role or feature not found.");
        Define("AGENT_FEATURE_DEPENDENCY_MISSING", "A Server Manager component is missing: {name}");
        Define("AGENT_FEATURE_DESCRIPTOR_MISSING", "Server Manager has no description for the component {name}.");
        Define("AGENT_FEATURE_REQUEST_FAILED", "Server Manager could not process the request.");
        Define("AGENT_FEATURE_REQUEST_FAILED_DETAIL", "Server Manager could not process the request. {detail}");
        Define("AGENT_FEATURE_REQUEST_STATE_UNKNOWN", "Server Manager reports an unknown state: {status}");
        Define("AGENT_FEATURE_INVENTORY_TIMEOUT", "Reading the roles from Server Manager takes longer than two minutes. Try again later.");
        Define("AGENT_FEATURE_INVENTORY_EMPTY", "Server Manager returned no roles or features.");
        Define("AGENT_FEATURE_CHANGE_TIMEOUT", "The role change is still running after two hours. Check the state before you make another change.");
        Define("AGENT_DISM_UNAVAILABLE", "The built-in Windows DISM API could not be loaded.");
        Define("AGENT_POWER_TIME_RANGE", "Choose a time between one minute and 30 days from now. If the device misses the time, the action does not run later.");
        Define("AGENT_INVALID_SCHEDULE_ID", "The schedule ID is not valid.");
        Define("AGENT_INVALID_SCHEDULE_PARAMETERS", "The schedule contains values that are not valid or not expected.");
        Define("AGENT_SCHEDULE_TIME_FORMAT", "Enter the time as a complete UTC date with Z.");
        Define("AGENT_SCHEDULE_DEFINITION_TOO_LARGE", "The schedule is too large.");
        Define("AGENT_SCHEDULE_TASK_FOREIGN", "A scheduled task with the same name exists, but Nodiverna did not create it. The agent does not change it.");
        Define("AGENT_SCHEDULE_DEFINITION_INCOMPLETE", "The scheduled restart or shutdown is incomplete. Remove the schedule and set it up again.");
        Define("AGENT_SCHEDULE_OWNERSHIP_UNVERIFIED", "The agent could not check who created the scheduled task and how it runs.");
        Define("AGENT_SCHEDULE_METADATA_MISSING", "Information about the schedule is missing.");
        Define("AGENT_SCHEDULE_PRINCIPAL", "The scheduled task does not run as SYSTEM, so the agent does not use it.");
        Define("AGENT_SCHEDULE_EXISTS", "A restart or shutdown is already scheduled. Remove that schedule first.");
        Define("AGENT_SCHEDULE_CHANGED", "The schedule changed in the meantime. Refresh the system inventory.");
        Define("AGENT_SCHEDULE_UNCONFIRMED", "Windows did not confirm the schedule. Check the Task Scheduler on the device before you try again.");
        Define("AGENT_RESTART_SCHEDULED", "Restart scheduled for {time} (schedule {scheduleId}). If the device misses the time, the restart does not run later.");
        Define("AGENT_SHUTDOWN_SCHEDULED", "Shutdown scheduled for {time} (schedule {scheduleId}). If the device misses the time, the shutdown does not run later.");
        Define("AGENT_SCHEDULE_NOT_FOUND", "This schedule no longer exists. Refresh the system inventory.");
        Define("AGENT_SCHEDULE_CHANGED_RELOAD", "The schedule changed in the meantime. Refresh the system inventory and try again.");
        Define("AGENT_SCHEDULE_REACHED", "The scheduled time has passed. A restart or shutdown that has started cannot be cancelled.");
        Define("AGENT_SCHEDULE_CANCELLED", "Scheduled restart or shutdown removed (schedule {scheduleId}).");
        Define("AGENT_RDP_POLICY_CONTROLLED", "A domain policy controls Remote Desktop on this device. The agent does not change this setting.");
        Define("AGENT_RDP_POLICY_BLOCKS_NLA", "A domain policy blocks NLA or TLS, so the agent did not turn on Remote Desktop.");
        Define("AGENT_RDP_LISTENER_UNSUPPORTED", "Windows does not support this RDP listener.");
        Define("AGENT_RDP_LISTENER_MISSING", "The Windows RDP listener is missing.");
        Define("AGENT_RDP_ENABLED", "Remote Desktop turned on with NLA and TLS. The agent opened no inbound firewall rules, because the portal connects through the agent.");
        Define("AGENT_RDP_DISABLED", "Remote Desktop turned off for new connections. Windows sessions that are open now stay signed in.");
        Define("AGENT_RDP_METHOD_REFUSED", "Windows refused {method}. Check the group policies and whether part of the change was made.");
        Define("AGENT_UPDATE_SEARCH_INCOMPLETE", "The update search did not finish completely (result code {resultCode}). Try again.");
        Define("AGENT_UPDATE_SCAN_DONE", "Update search finished: {count} update available.", "Update search finished: {count} updates available.");
        Define("AGENT_UPDATES_ALL_AND_IDS", "Choose either all updates or single updates, not both.");
        Define("AGENT_UPDATES_IDS_REQUIRED", "Choose the updates to install.");
        Define("AGENT_UPDATES_INVALID_ID", "An update ID is not valid or appears twice.");
        Define("AGENT_UPDATES_AMBIGUOUS_IDS", "The update search returned the same ID for different updates. Nothing was installed.");
        Define("AGENT_UPDATES_SELECTION_GONE", "At least one selected update is no longer available. Run the update search again.");
        Define("AGENT_UPDATES_INTERACTIVE", "At least one update needs user interaction on the device. Nothing was installed. Install this update on the device, or choose other updates.");
        Define("AGENT_UPDATES_INSTALLED", "{count} update installed. Restart the device to finish. The agent did not restart it.", "{count} updates installed. Restart the device to finish. The agent did not restart it.");
        Define("AGENT_UPDATES_INSTALLED_NO_RESTART", "{count} update installed. No restart is required.", "{count} updates installed. No restart is required.");
        Define("AGENT_UPDATES_PARTIAL", "{count} update installed. Restart the device to finish. The agent did not restart it. {detail} The failed updates are not retried.", "{count} updates installed. Restart the device to finish. The agent did not restart it. {detail} The failed updates are not retried.");
        Define("AGENT_UPDATES_PARTIAL_NO_RESTART", "{count} update installed. No restart is required. {detail} The failed updates are not retried.", "{count} updates installed. No restart is required. {detail} The failed updates are not retried.");
        Define("AGENT_UPDATES_INVALID_WINDOWS_ID", "Windows reports an invalid update ID. Nothing was installed.");
        Define("AGENT_UPDATES_DUPLICATE_WINDOWS_ID", "Windows reports several updates with the same ID. Nothing was installed.");
        Define("AGENT_UPDATES_NONE", "The update search found no updates. Nothing was installed, and the device was not restarted.");
        Define("AGENT_UPDATES_INSTALLER_BUSY", "Windows is already installing other updates. Try again when that installation is finished.");
        Define("AGENT_UPDATES_REBOOT_FIRST", "Restart the device before you install the remaining updates.");
        Define("AGENT_UPDATES_DOWNLOAD_INCOMPLETE", "The update download did not finish completely (result code {resultCode}). Try again.");
        Define("AGENT_UPDATES_RESULT", "Windows Update ended with result code {resultCode}. Check which updates were installed.");
        Define("AGENT_DESIRED_STATE_MANAGEMENT_REQUIRED", "Desired State runs only in Management mode, also for checks. Turn on Management mode on the device and try again.");
        Define("AGENT_DESIRED_STATE_JOB_INVALID", "The Desired State job is not valid.");
        Define("AGENT_DESIRED_STATE_ENVELOPE_INVALID", "The Desired State configuration package is not valid.");
        Define("AGENT_DESIRED_STATE_INTEGRITY_FAILED", "The Desired State configuration failed the integrity check. The agent did not use it.");
        Define("AGENT_DESIRED_STATE_CONTENT_MISMATCH", "The content of the Desired State configuration does not match its checksum or size. The agent did not use it.");
        Define("AGENT_DESIRED_STATE_COMPLIANT", "The device matches the Desired State.");
        Define("AGENT_DESIRED_STATE_DRIFT", "The device differs from the Desired State.");
        Define("AGENT_DSC_UNKNOWN_ENGINE", "The agent does not know this DSC engine.");
        Define("AGENT_DSC_MOF_NO_PARAMETERS", "A compiled MOF file takes no parameters. Remove the parameters.");
        Define("AGENT_DSC_RESULT_TOO_LARGE", "The DSC result is too large to send to the portal.");
        Define("AGENT_DSC_TOO_MANY_PARAMETERS", "The configuration has too many parameters.");
        Define("AGENT_DSC_INVALID_PARAMETER", "A configuration parameter is not valid.");
        Define("AGENT_DSC_SIMPLE_PARAMETERS", "Only simple configuration parameters are allowed.");
        Define("AGENT_DSC_OS_UNSUPPORTED", "Desired State needs Windows Server 2022, Windows Server 2025 or Windows 11.");
        Define("AGENT_DSC_MOF_TOO_LARGE", "The compiled MOF configuration is larger than 1 MiB.");
        Define("AGENT_DSC_BUSY", "A DSC run is still active on the device. The agent did not start another one. Try again later.");
        Define("AGENT_DSC_LCM_UNREADABLE", "The agent could not read the settings of the DSC Local Configuration Manager.");
        Define("AGENT_DSC_LCM_AUTO_REBOOT", "The DSC Local Configuration Manager can restart the device by itself. Turn off RebootNodeIfNeeded on the device before Nodiverna applies this configuration.");
        Define("AGENT_DSC_LCM_AUTO_CORRECT", "The DSC Local Configuration Manager corrects configurations by itself. Set it to ApplyAndMonitor or ApplyOnly on the device first.");
        Define("AGENT_DSC_LCM_BUSY", "The DSC Local Configuration Manager is busy or needs a restart. The configuration was not applied.");
        Define("AGENT_DSC_NO_COMPLIANCE", "DSC did not report clearly whether the device matches the configuration.");
        Define("AGENT_DSC_PROVIDER_NO_RESULT", "The DSC provider returned no result for {method}.");
        Define("AGENT_DSC_PROVIDER_ERROR", "The DSC provider {method} reports error {status}. Check the Windows DSC event log.");
        Define("AGENT_DSC_INVALID_RESOURCE_OUTPUT", "A DSC resource returned output that the agent cannot read.");
        Define("AGENT_DSC_TOO_MANY_RESOURCES", "The configuration has more than 200 resources. Split it into smaller configurations.");
        Define("AGENT_DSC_INVALID_CONFIGURATION_NAME", "The Configuration name is not valid.");
        Define("AGENT_DSC_COMPILER_MISSING", "Windows DSC 1.1 needs Windows PowerShell 5.1 to compile a PS1 configuration. Install this Windows component, or upload a compiled MOF file.");
        Define("AGENT_DSC_COMPILE_FAILED", "The DSC Configuration could not be compiled: {detail}");
        Define("AGENT_DSC_NO_MOF", "Windows DSC did not create a MOF configuration.");
        Define("AGENT_DSC3_VERSION", "This configuration needs DSC 3.2 or a later 3.x version.");
        Define("AGENT_DSC_OPERATION_FAILED", "DSC could not complete the operation: {detail}");
        Define("AGENT_DSC_INVALID_JSON", "DSC returned no valid JSON output.");
        Define("AGENT_DSC_RESOURCE_ERROR", "DSC reports a resource error. Check the modules, resources and configuration on the device.");
        Define("AGENT_DSC_NO_RESOURCES", "DSC returned no resource results.");
        Define("AGENT_DSC_REPARSE", "The path to the DSC engine contains a link, so the agent does not run it.");
        Define("AGENT_DSC3_MISSING", "DSC 3 is not installed. Install DSC 3.2 or later under Program Files on the device and add it to the PATH of SYSTEM, or use {path}.");
        Define("AGENT_DSC_PROCESS_START", "The DSC process could not be started.");
        Define("AGENT_DSC_OUTPUT_LIMIT", "The DSC output is too large or could not be read.");
        Define("AGENT_DSC_OUTPUT_TOO_LARGE", "The DSC output is too large.");
        Define("AGENT_GPU_DRIVER_INSTALLED", "Graphics driver {version} installed.");
        Define("AGENT_GPU_DRIVER_INSTALLED_REBOOT", "Graphics driver {version} installed. Restart the device to finish.");
        Define("AGENT_GPU_DRIVER_SIGNATURE", "The downloaded driver package is not signed by {vendor}. The agent did not run it.");
        Define("AGENT_GPU_DRIVER_DOWNLOAD_FAILED", "The driver package could not be downloaded. Check that the device can reach {host}, then try again.");
        Define("AGENT_GPU_DRIVER_DISK_SPACE", "Not enough free space on the system drive. Free at least {size}, then try again.");
        Define("AGENT_GPU_DRIVER_INSTALL_FAILED", "The installer stopped with exit code {code}. Check the installer log on the device, then try again.");
        Define("AGENT_GPU_DRIVER_TIMEOUT", "The driver installation did not finish within 30 minutes. Check the device, then try again.");
        Define("AGENT_GPU_DRIVER_NO_GPU", "This device has no {vendor} graphics card. Refresh the inventory, then try again.");
        Define("AGENT_GPU_DRIVER_INVALID", "The driver job has invalid parameters. Start the update again from the portal.");
        Define("AGENT_DEFENDER_QUICK_SCAN_STARTED", "Defender started the quick scan. The Defender area shows the result when the scan ends.");
        Define("AGENT_DEFENDER_FULL_SCAN_STARTED", "Defender started the full scan. The Defender area shows the result when the scan ends.");
        Define("AGENT_DEFENDER_SCAN_COMPLETED", "Defender completed the scan.");
        Define("AGENT_DEFENDER_SCAN_RUNNING", "A scan that the portal started is still running on this device. Wait until it ends, then try again.");
        Define("AGENT_DEFENDER_SIGNATURES_UPDATED", "Defender signatures are up to date. Version: {version}.");
        Define("AGENT_DEFENDER_DETECTIONS_CLEANED", "Defender cleaned the active detections: {count}.");
        Define("AGENT_DEFENDER_DETECTIONS_REMAIN", "Defender cleaned {cleaned} detections, and {remaining} are still active. Run a full scan or restart the device, then try again.");
        Define("AGENT_DEFENDER_NO_ACTIVE_DETECTIONS", "There were no active detections to clean.");
        Define("AGENT_DEFENDER_UNAVAILABLE", "Microsoft Defender is not installed or not running on this device.");
        Define("AGENT_DEFENDER_ACTION_FAILED", "Defender refused the action: {detail}");
        Define("AGENT_DEFENDER_TIMEOUT", "Defender did not finish within {minutes} minutes. Check the Defender area, then try again.");
        Define("AGENT_PLUGIN_INSTALLED", "The plugin {name} {version} is installed.");
        Define("AGENT_PLUGIN_REMOVED", "The plugin {name} is removed.");
        Define("AGENT_PLUGIN_NOT_INSTALLED", "The plugin {name} is not installed on this device.");
        Define("AGENT_PLUGIN_SIGNATURE_INVALID", "The plugin signature does not match the publisher key. The agent did not start the plugin. Repair the plugin.");
        Define("AGENT_PLUGIN_HASH_MISMATCH", "The plugin file changed on the device. The agent did not start it. Repair the plugin.");
        Define("AGENT_PLUGIN_AGENT_TOO_OLD", "The plugin needs agent {version} or later. Update the agent.");
        Define("AGENT_PLUGIN_FOLDER_UNSAFE", "The plugin folder has unsafe permissions. The agent did not start the plugin. Repair the plugin.");
        Define("AGENT_PLUGIN_HANDSHAKE_FAILED", "The plugin did not identify itself correctly. Repair the plugin.");
        Define("AGENT_PLUGIN_TIMEOUT", "The plugin did not answer in time. The agent stopped it. Try again.");
        Define("AGENT_PLUGIN_CRASHED", "The plugin stopped unexpectedly (exit code {exitCode}). The agent keeps running. Try again.");
        Define("AGENT_PLUGIN_OUTPUT_INVALID", "The plugin sent an answer the agent cannot read. Try again.");
        Define("AGENT_PLUGIN_OPERATION_UNKNOWN", "The installed plugin does not support this operation. Update the plugin.");
        Define("AGENT_PLUGIN_BUSY", "The plugin is busy with another job. Try again in a minute.");
        Define("AGENT_PLUGIN_SECRET_INVALID", "The secret of this job could not be opened. Try again.");
        // 4.21.2: a plugin-job result always carries a code; the exception text goes only to the agent log.
        Define("AGENT_PLUGIN_UPLOAD_FAILED", "The plugin read the data, but the agent could not send them to the portal. Try again.");
        Define("AGENT_PLUGIN_FAILED", "The agent could not run the plugin. Try again. If it fails again, check the agent log on the device.");
        // AD sign-in for plugin changes (4.19.0, PluginIdentity.cs).
        Define("AGENT_AD_SIGNED_IN", "The account {account} is verified.");
        Define("AGENT_AD_SIGN_IN_FAILED", "The account or password is wrong. Check both and try again.");
        Define("AGENT_AD_ACCOUNT_RESTRICTED", "{account} cannot sign in now. It is disabled, locked, expired or outside its logon hours. Ask your AD administrator.");
        Define("AGENT_AD_PASSWORD_EXPIRED", "The password of {account} has expired or must be changed. Change it in Windows, then sign in again.");
        Define("AGENT_AD_NO_LOGON_RIGHT", "{account} may not sign in to this server over the network. Check the user rights of the server.");
        Define("AGENT_AD_DOMAIN_UNREACHABLE", "The server cannot reach a domain controller. Check its network and DNS, then try again.");
        Define("AGENT_AD_LOCAL_ACCOUNT", "This is a local account of the server. Use an account of the domain.");
        Define("AGENT_AD_SIGN_IN_ERROR", "Windows refused the sign-in (error {error}). Try again.");
        Define("AGENT_PLUGIN_ACCOUNT_REQUIRED", "This change needs an AD account. Sign in with your AD account and try again.");
        Define("AGENT_PLUGIN_ACCOUNT_UNAVAILABLE", "Windows could not sign in {account} for this change. The account may be disabled, locked or deleted. Sign in again with your AD account.");
        Define("AGENT_PLUGIN_ACCOUNT_MISMATCH", "The AD account of this change no longer matches the account in AD. Sign in again with your AD account.");
        Define("AGENT_PLUGIN_ACCOUNT_DENIED", "The server refused this change for {account}. Add the account to the group that manages this role on the server, for example DnsAdmins or DHCP Administrators, or sign in with another account.");
        // The codes of the DHCP plugin (agent/plugins/dhcp); the broker passes them through unchanged.
        Define("PLUGIN_DHCP_READ_COMPLETED", "The DHCP server was read. Scopes: {scopes}, leases: {leases}.");
        Define("PLUGIN_DHCP_SERVICE_STOPPED", "The DHCP Server service is stopped. Start the service in Management → Services.");
        Define("PLUGIN_DHCP_ACCESS_DENIED", "The DHCP server refused access to the DHCP plugin. On the server, check the members of the groups DHCP Administrators and DHCP Users.");
        Define("PLUGIN_DHCP_NOT_INSTALLED", "The DHCP Server role is not installed on this device. Install the role in Management → Roles & features, or remove the DHCP plugin in the Extensions area.");
        Define("PLUGIN_DHCP_READ_FAILED", "The DHCP server could not be read (error {error}). Try again.");
        // The changes of DHCP plugin 1.1.0.
        Define("PLUGIN_DHCP_CHANGED", "The DHCP server was changed.");
        Define("PLUGIN_DHCP_CHANGED_NOT_READ", "The DHCP server was changed, but the plugin could not read it afterwards. Select “Read again” to see the change.");
        Define("PLUGIN_DHCP_INVALID_CHANGE", "The DHCP plugin did not make the change because the value of {field} is not valid. Correct the value and try again.");
        Define("PLUGIN_DHCP_OBJECT_EXISTS", "{object} already exists on the DHCP server. Select “Read again” to see the current state.");
        Define("PLUGIN_DHCP_OBJECT_MISSING", "{object} does not exist on the DHCP server. Select “Read again” to see the current state.");
        Define("PLUGIN_DHCP_IN_FAILOVER", "Scope {scope} is part of a failover relationship. Remove the scope from the relationship on the Failover tab, and try again.");
        Define("PLUGIN_DHCP_SECRET_MISSING", "The shared secret did not reach the DHCP plugin. Update the agent on this device to 4.17.0 or later, and try again.");
        Define("PLUGIN_DHCP_CHANGE_FAILED", "The DHCP server refused the change (error {error}). Check the values and try again.");
        // The DNS plugin 1.0.0 (agent/plugins/dns, docs/dns-server.md).
        Define("PLUGIN_DNS_READ_COMPLETED", "The DNS server was read. Zones: {zones}.");
        Define("PLUGIN_DNS_ZONE_READ_COMPLETED", "Zone {zone} was read. Records: {records}.");
        Define("PLUGIN_DNS_SERVICE_STOPPED", "The DNS Server service is stopped. Start the service in Management → Services.");
        Define("PLUGIN_DNS_NOT_INSTALLED", "The DNS Server role is not installed on this device. Install the role in Management → Roles & features, or remove the DNS plugin in the Extensions area.");
        Define("PLUGIN_DNS_READ_FAILED", "The DNS server could not be read (error {error}). Try again.");
        Define("PLUGIN_DNS_ACCESS_DENIED", "The DNS server refused access to the DNS plugin. On the server, check the members of the group DnsAdmins.");
        Define("PLUGIN_DNS_CHANGED", "The DNS server was changed.");
        Define("PLUGIN_DNS_CHANGED_NOT_READ", "The DNS server was changed, but the plugin could not read it afterwards. Select “Read again” to see the change.");
        Define("PLUGIN_DNS_INVALID_CHANGE", "The DNS plugin did not make the change because the value of {field} is not valid. Correct the value and try again.");
        Define("PLUGIN_DNS_OBJECT_EXISTS", "{object} already exists on the DNS server. Select “Read again” to see the current state.");
        Define("PLUGIN_DNS_OBJECT_MISSING", "{object} does not exist on the DNS server. Select “Read again” to see the current state.");
        Define("PLUGIN_DNS_NOT_DOMAIN_CONTROLLER", "This server is not a domain controller, so it cannot store zones in Active Directory. Store the zone in a file on this server instead.");
        Define("PLUGIN_DNS_CHANGE_FAILED", "The DNS server refused the change (error {error}). Check the values and try again.");
        Define("PLUGIN_DNS_CHANGE_FAILED_DETAIL", "The DNS server refused the change (error {error}). Windows reports: {detail} Check the values and try again.");
        // agent-messages:end
    }
}
