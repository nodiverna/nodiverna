# Roles and features

The **Installed roles** area is above the alphabetical **Role catalog**. Roles group the role services and subservices that Windows reports. The two areas are collapsed at the start. The search also finds technical names and child services and shows their role path. The installed area shows only installed components. A parent node that is not installed, but has installed children, stays visible as **Partially installed**.

Additional features have their own view with an overview of the installed features and a catalog. The switch **Roles** and **Features** with their counts is next to the search in the toolbar. Windows 11 shows its optional features directly, without the switch.

Each row has one menu **Actions for {name}** with one entry, which opens the drawer before the confirmation:

- **Install…** for a component that is not installed
- **Remove…** for an installed component, in red

When you cannot use the action, the entry stays in the menu and tells you why. Installation and removal use the same jobs, confirmations and permissions as before. They also use the same checks for Management mode, online state and agent capability.

Agent 3.1.1 sends the optional fields `parent`, `subFeatures` and `depth` from `Get-WindowsFeature`. The portal continues to accept agent 3.1.0 payloads. Without a hierarchy, role services show under **More role services**. The portal does not guess dependencies from name prefixes. Missing, contradictory or cyclic parents keep components visible and limit the tree structure. The large telemetry payload does not shorten the role inventory to 300 entries now, and the role inventory has a limit of 1,000 components.

The area **Extensions** of a Windows server and the report **Inventory → Extensions** of the fleet use these roles to show the server roles of the device. See [Extensions](extensions.md).

Microsoft describes the catalog of roles, role services and features with [Get-WindowsFeature](https://learn.microsoft.com/powershell/module/servermanager/get-windowsfeature). The [PowerShell/PSDscResources tests of the Microsoft project](https://www.powershellgallery.com/packages/PSDscResources/2.4.0.0/Content/Tests%5CUnit%5CMSFT_WindowsFeature.Tests.ps1) also use the hierarchy fields as `Parent`, `SubFeatures` and `Depth`.

Checks: `node tests/ui/devices/feature-catalog.mjs`, `node tests/ui/devices/roles-features-view.mjs` and `dotnet run --project agent/v3/ServerDesk.Agent.csproj -c Release -- --features-self-test`. The native tests check Windows and DISM structures and display names with sample data. They do not change Windows roles. The full agent self-test also contains the native feature provider tests.
