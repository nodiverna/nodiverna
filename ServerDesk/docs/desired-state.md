# Desired State in ServerDesk

ServerDesk controls DSC locally through the authenticated agent channel. It supports Windows Server 2022 and 2025 and Windows 11. It does not need Azure subscriptions, Azure Arc or Azure Machine Configuration. Azure Machine Configuration from Microsoft is a separate Azure orchestration product. ServerDesk does not claim that it runs the cloud agent of that product independently.

## Configuration formats

| Format | Local runtime | Portal workflow |
| --- | --- | --- |
| DSC 3 JSON | DSC 3.2 or later within major version 3, installed by an administrator below Program Files; required resources installed locally | Edit/upload/import, assign an immutable version, test or apply; per-resource compliance and differing property names |
| PowerShell `.ps1` | Windows PowerShell 5.1 and its built-in `PSDesiredStateConfiguration` | Script defines the specified `Configuration` with exactly one local Node (`localhost` or the machine name), compiles locally, tests the generated reference MOF or applies it |
| Compiled `.mof` | Windows PowerShell DSC | Upload/import a single-node compiled configuration, test the reference or apply it |

Windows PowerShell DSC also needs the locally installed PSDSC resources and a correctly configured local WinRM and LCM service. This also applies to the Windows PowerShell adapter of DSC 3. You must prepare these items explicitly, also on Windows 11. ServerDesk does not enable network listeners, download modules or install DSC automatically.

Install the standalone DSC executable and its packaged resource files in `C:\Program Files\DSC`. You can also use a different Program Files directory that an administrator owns and that is on the PATH of SYSTEM. If you install only `dsc.exe` without the related resources, DSC does not work.

For Windows PowerShell `.ps1`, give the name of the `Configuration`, for example `ServerDeskConfig`. Optional parameter values are strings, numbers or booleans. `OutputPath` and `ConfigurationData` are reserved. MOF uploads have no parameters.

Each content version is immutable, and its SHA-256 identifies it. Its maximum size is 64 KiB, and the encoded transport envelope also has a limit. When you edit a configuration, the portal creates a new version.

An assignment pins one exact version for each device. When you upload a newer version, the portal does not silently send it to the devices. To assign a different version, you must first explicitly remove the existing assignment. If you assign the same version and check interval again, nothing changes, and the queued work stays. A bulk assignment validates each target and commits all new assignments atomically. If there is a conflict, none of the selected devices changes.

Reference MOF tests do not change the existing LCM configuration. The reference test API of Windows PowerShell gives only an overall result. It does not support the `-Detailed` switch with `-ReferenceConfiguration`. Details for each resource are available after you apply the Windows PowerShell configuration and for all DSC 3 tests. The UI shows this difference.

When you apply a Windows PowerShell configuration, it replaces the local configuration that the LCM manages. The portal refuses the apply if the existing LCM enables an automatic reboot or `ApplyAndAutoCorrect`. Before a manual apply from ServerDesk, an administrator must explicitly change those settings locally. The orchestration of ServerDesk never schedules an automatic apply or reboot. Custom resources and scripts can run any code, also disruptive operations. Thus assign only configurations that somebody has reviewed.

## Rights and execution

- `desired.read`: read the permitted assignments, versions and compliance results.
- `desired.manage`: create or import immutable configurations and manage the assignments on permitted devices.
- `desired.apply`: send test jobs and apply jobs to permitted devices.

A test and a compilation can run any resource code. Thus they need the same items as an apply:

- Local **Management**.
- An authenticated portal session with MFA.
- The explicit consent to run as SYSTEM.

An apply also needs the explicit maintenance consent.

In the console, **Check** and **Apply** open a confirmation with the device and the configuration. **Check** has one switch for the run as SYSTEM. **Apply** also has a switch for the maintenance consent. The confirm button stays blocked until you turn on all switches of the job.

The German console calls this feature `Sollkonfiguration` in all places: the navigator, the device tab, the permission names and the error texts. The English console keeps **Desired State**.

The queue takes the encrypted content only from the immutable version that is already assigned. The generic operation API cannot send any other DSC payloads. Before the dispatch, the portal checks these items again: the device capability, the current rights of the principal, the active assignment and the pinned version.

When you remove an assignment, the portal cancels the pending DSC jobs and the scheduled checks of that assignment. The local configuration on the device stays. The portal rejects the removal while a DSC operation runs. Wait until the operation is complete. A new assignment gets a new identity, so old results cannot show as compliance for the new assignment. The portal does not automatically replay or reverse operations that already run.

Before the portal queues the configuration content of a device, it seals the content. It uses the RSA public key of the agent and authenticated AES. Local job input uses machine DPAPI. Temporary compile and DSC files are in the restricted job directory of the agent. The agent deletes them at completion or timeout. The HTTPS agent transport and the existing processing of protocol results stay in use.

The portal stores the configuration source in its authorized configuration library. Do not put passwords, personal access tokens or other secrets in the source or in parameters. The portal shows compliance and property names, but not the full desired and actual resource values.

## Periodic compliance

An assignment can run manual checks. It can also repeat **tests only**, at an interval from 15 minutes to 24 hours. You change the check interval separately on an existing assignment. This change uses the expected version and the previous interval of the assignment, so that the portal rejects old concurrent edits. A change of the interval does not cancel the current work.

To enable periodic checks, you need explicit SYSTEM consent, local Management and `desired.apply`, in addition to `desired.manage`. The portal queues due checks when the device connects to the portal. While a different job is active, the portal sends no work.

The principal that made the assignment must stay approved, enrolled in MFA and permitted for the device. If its rights are removed, the check interval is disabled. The portal never replays jobs with an unknown result or jobs that are only partially complete. There is intentionally no automatic remediation. For remediation, use the explicit Apply action.

## Portal status and bounded polling

The device view shows its newest operation separately from its last successful compliance result. This result is for the exact active assignment and version. The view never shows a pending, running or failed operation as a new successful check. The portal gets these summaries independently from the last 100 entries of the fleet history. Thus a busy fleet cannot hide the current result of a quiet device.

`lastProgressAt` comes from the job progress, and `resultAt` comes from the stored output receipt. The portal shows neither value as a false completion time. The assignment stores its last result: succeeded or failed, with the job id and the time. It also stores its last compliance verdict with the time. The agent channel writes these values in the same transaction as the job result.

The run history, the resource details and the failure messages expire with their jobs after the job retention of the page **Data retention**. The stored result and the verdict stay. Thus a device that you checked manually continues to show its last verdict and not "not checked yet".

The configuration library resolves the device scope one time for each request. It ranks the version metadata in SQL. It gets the bounded summaries of the history and the current state in a fixed number of database queries. It does not get the source or the parameters during background polls.

The polling extracts bounded compact output summaries and resource counts in SQL. It does not load full resource arrays into the server. Only the detail endpoint of the selected run loads the resource arrays. This endpoint checks `desired.read` again on the exact device. Failed or pending runs never report a successful overall compliance, also if a partial output contains a positive flag.

The list contains the latest 60 versions of each visible configuration and each older version that is still actively pinned. Assignment responses show for each device if it is newly assigned or unchanged. The responses for schedules, removals and queued runs give explicit feedback.

## GitHub import and versioning

The import accepts an owner, a repository, a branch or commit and one file path. The server resolves the ref to a full commit SHA and gets that file at the resolved SHA. It records the owner, the repository, the path, the ref and the commit with the immutable version. Later branch changes cannot change an existing portal version. To create a new version, import the same source again, review it and explicitly assign it. ServerDesk reads files, but it does not push edits, configure webhooks or create a GitHub OAuth connection.

ServerDesk connects only to `https://api.github.com`. It rejects redirects, other URLs, path traversal, symlinks, directories, content that is not UTF-8 and files over the content limit. GitHub responses have limits for time and size. Public repositories work without a token. Private imports can use a configuration on the server:

```
DESIRED_STATE_GITHUB_TOKEN=<server-side secret>
DESIRED_STATE_GITHUB_REPOSITORIES=organization/repository,organization/another-repository
```

Store the token as a runtime secret. Never put it in the client bundle or as plain text in the database. Use a fine-grained, read-only token for repository contents and metadata.

Only portal administrators can do authenticated imports with the private token. The shared token does not give operators with a device scope access to private repositories. ServerDesk sends the token only for repositories that the allowlist explicitly contains. It queries other repositories anonymously. Administrators can see if a private connection is available. The browser never gets the token.

## Primary references

- [Microsoft DSC configuration documents](https://learn.microsoft.com/en-us/powershell/dsc/concepts/configuration-documents/overview?view=dsc-3.0)
- [Microsoft DSC config test](https://learn.microsoft.com/en-us/powershell/dsc/reference/cli/config/test?view=dsc-3.0)
- [Microsoft DSC config set](https://learn.microsoft.com/en-us/powershell/dsc/reference/cli/config/set?view=dsc-3.0)
- [Microsoft Windows PowerShell adapter](https://learn.microsoft.com/en-us/powershell/dsc/reference/resources/microsoft/adapter/windowspowershell/?view=dsc-3.0)
- [Windows PowerShell Test-DscConfiguration parameter sets](https://learn.microsoft.com/en-us/powershell/module/psdesiredstateconfiguration/test-dscconfiguration?view=dsc-1.1)
- [DSC resource test result schema](https://learn.microsoft.com/en-us/powershell/dsc/reference/schemas/outputs/resource/test?view=dsc-3.0)
- [Standalone DSC releases](https://github.com/PowerShell/DSC/releases)

## Validation limits

Automated tests run in the Linux development environment. They cover the portal and the authorization, the envelope, the schema, the assignments and the script parser. Before you use a configuration in production, validate it on a real Windows device. Only such a device shows the behavior of the LCM, the resources and the modules on that OS.
