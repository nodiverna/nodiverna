# Automation

Under **Automation**, you manage runbooks, Desired State and
drift in one location. You assign a template to a device group or to a
single device. **Device status** shows the effective assignment.
It also shows devices that are blocked, suspended or locally changed.

## Pages and tabs

The navigator shows three pages in this order: **Runbooks**, **Desired State**
and **Configuration drift**. Each page has one tab bar. The first tab opens
when you open the page. The address keeps the tab, for example
`#automation/runbooks/schedules`. Back and Forward in the browser go to the
previous tab.

| Page | Tabs | Page button |
|---|---|---|
| **Runbooks** | **Runbooks**, **Runs**, **Schedules**, **Assignments**, **Device status** | **Create runbook** |
| **Desired State** | **Configurations**, **Assignments**, **Device status**, **History** | **Create configuration** |
| **Configuration drift** | **Assignments**, **Device status**, **Reference devices** | **Create template** |

The page button is the same on each tab of the page. **Create runbook** and
**Create configuration** open the first tab and the editor. While the editor is
open, its **Save version** button replaces the page button. Without the
management right, with sample devices or with a locked MSP library, the page
button stays visible and shows the reason.

On **Assignments**, the **Templates** card lists the templates. Use **Assign
template…** in the row menu to assign a template. The **Assignments** card lists
the groups and devices with a template. Its row menu has **Start runbook…** and
**Remove assignment…**. **Create template** and **Assign template** open a side
panel. Remove and start ask for a confirmation first.

## Runbooks, runs and schedules

When you save a new runbook, the editor closes and **Prepare {name}** opens with
the new version. Select the devices, then click **Preview**. **Start runbook**
or **Save schedule** opens a confirmation. When you save a new version of a
runbook, the row of the runbook shows in the list, and no panel opens.

**Stop run…** is in the row menu of a run that did not finish. It is also in the
output panel of the run. It asks first. The run then starts no more steps. Steps
that run on a device at that time continue until they finish.

**Schedules** lists the two ways a runbook runs regularly. The **Source** column
shows **Schedule** for a run that you saved with **Save as schedule**. It shows
**Assignment** for a runbook template with **Run regularly** that you assigned
to a group or a device. An assignment gets its next run time after the next
device report. Until then, **Next run** shows **After the next device report**.

**Turn off** stops a schedule. **Show assignment** opens the assignment on the
**Assignments** tab.

[`v3-automation.md`](v3-automation.md) describes the runbook versions, the secret
parameters, the schedule rules and the optional drift monitoring in detail.

## Templates and inheritance

- **Drift:** Copy the data sources from the reference device. As an option, use
  the last complete scan as a shared baseline.
- **Desired State:** Assign a fixed configuration version and a check interval.
  The check runs manually or at an interval from 15 minutes to 24 hours.
- **Runbooks:** Assign a fixed runbook version with parameters, an optional
  schedule, a catch-up window, parallelism and a stop on error. Without a
  schedule, a run starts only after an explicit confirmation. Necessary secrets
  need an explicit device campaign.

In the runbook library, each runbook has one menu **Actions for {name}**. It
contains **Prepare run…**, **New version…** and **Delete runbook…**.
**Prepare run…** opens the side panel **Prepare {name}**. After **Preview**,
**Start runbook** opens a confirmation. The confirmation shows the runbook, the
version and the devices, and its button is also **Start runbook**.

A root group can contain up to four levels of subgroups. Assignments apply to
the devices and subgroups of their group. Direct device assignments have
priority. If there is no direct assignment, the deepest group wins. A device
belongs to exactly one device group, so there are no groups of equal rank with
conflicting templates now.

The conflict handling stays as a safeguard. A conflict stops the affected scope,
and ServerDesk does not select a template at random. Drift and Desired State
each have their own resolution, and runbooks have a resolution for each
runbook.

**Pause inherited automation for this scope** overrides an inherited assignment
in the selected scope.
After you remove an assignment, a parent assignment can become effective again.
Group inheritance does not overwrite existing local drift policies and active
Desired State assignments. Later local changes also stay, and they show as
**Changed locally**.

## MSP library and customer templates

When the portal has more than one customer, each template and each runbook belongs to the MSP library or to a
customer. When you create one, select the owner under **Belongs to**. You can assign the templates of a customer only to the groups and devices
of this customer. The runbooks of a customer run only on the devices of this
customer. Drift baselines belong to the customer of the reference device. From
then on, only Owners can change the MSP library.

Desired State configurations stay valid for the full instance. For more
information, refer to
[`customers.md`](customers.md#catalogs-msp-library-and-customer-entries).

## Approval and execution

Templates, assignments and manual starts need MFA and the applicable management
rights. An assignment approval belongs to the account that approved it and to
its `auth_version`. ServerDesk blocks the approval in these cases: the account is locked, the
account version changed, MFA is missing or somebody withdrew the device rights.
A different account does not take the approval automatically.

A new assignment with MFA binds the account and the account version again. ServerDesk checks the
rights and the effective assignment again at the write and execution limits.

Drift templates contain copied reference data and baselines. Only their creator
or a current administrator can see and assign them. Read rights on other
devices do not give access to these templates. When you save a template,
ServerDesk checks the template content and this permission again.

New group members get drift and Desired State at their next agent report.
Removed, suspended or invalid inherited assignments stop further collection or
scheduled checks, if the resource still comes from this assignment. ServerDesk
does not reset Windows configurations that it applied already. This does not
interrupt tasks that run at that time.

The DSC check interval schedules only **Test**. **Apply** occurs only through a
separate management action that you confirm. Automatic tests need an applicable
agent in Management mode and the necessary rights.

Runbook schedules keep one central cursor for each assignment. Agent reports
start the check. A due time makes one shared campaign for the target devices
that are effective at that time, with a maximum of 1000 devices. Future
campaigns include new members. A parallelism from 1 to 10 limits the devices
that run at the same time in one campaign, not each agent separately. ServerDesk
skips catch-up windows that expired.

Conflicts, suspension and withdrawn approvals stop further steps and their
transfer to agents. Each start of a runbook assignment writes one audit entry
for each target device. This occurs for manual starts and for scheduled starts,
in the same step as the campaign. A manual start records the actor, and a
scheduled start records `System`. If ServerDesk cannot save the entry, the
campaign does not start.

[device-groups.md](device-groups.md) describes the group management, and
[local-identity-rbac.md](local-identity-rbac.md) describes the permissions.
