# Remote file browser

The Files view lists local fixed, removable and optical drives. It gets a new
directory listing through an authenticated, encrypted Agent v3 command. It
supports breadcrumbs, direct paths, page filters and sorting, and properties.
It can also create folders, rename items, delete files and delete empty
folders. Each page of a listing has 200 entries. The directory enumeration
stops at 20,000 names, so that responses stay in the 256 KiB limit of the channel.

To open a large folder, use the direct path of its subdirectory.

## The view

**Remote › Files** shows the path line, the breadcrumbs and the listing. Each drive card shows its free space and a meter for the used space. A folder listing is one table with the columns **Name**, **Size** and **Last modified**. Select a column head to sort by it. Folders always come first.

The toolbar has the name filter and the actions **Folder** and **Upload**. Each page has 200 entries, and the table foot has the page buttons.

Each row has one menu **Actions for {name}** with these entries:

- **Open** (folders) or **Download** (files)
- **Rename**
- **Delete**, the last entry after a separator

A click on a folder row opens the folder. A blocked entry stays in the menu and tells you why. When you cannot change files on the device, one notice tells you why and that you can still browse and download.

**Delete** asks first. The dialog **Delete {name}?** shows the device and the path. Select **Delete** to queue the job, or **Cancel** to send nothing.

**Upload** opens the card **Upload files**. Choose the files, then select **Upload**. Without a file, **Upload** tells you to select a file first. The dialog **Upload {count} files?** shows the device and the folder. With **Overwrite existing files** on, it also tells you that files with the same name are overwritten. A paused upload resumes without a second dialog.

In the path picker of Drift, the title **Choose path** and its close button stay. A click on a row selects it, and **Choose** returns the path.

The same `FilePicker` component supplies the file and folder selection for
Drift. Manual paths stay available when browse permissions or an updated agent
are missing. The view requests directory listings only during navigation or an
explicit refresh. Background telemetry does not enumerate a file system
recursively.

`files.read` gives directory browsing and downloads. `files.write` gives uploads
and guided changes. It also needs an agent with the local configuration
Management. All requests also need the current portal MFA session and an
approved identity in the scope of the device. Only the user who submitted the
job can get the results. ServerDesk checks permission changes again before the
agent runs the job.

Security event files and support or event exports need `security.events`.
Listings do not show these files, unless the user explicitly requested this
scope and got approval for it.

The bytes move through the existing HTTPS chunk-transfer API and the private
object bucket, not through TFTP. Each file has a limit of 256 MiB, and the transfer
uses chunks of 256 KiB. The agent checks each file with SHA-256. It commits the file
only after it verifies the integrity and the authorization.

The browser supports multiple local files, drag and drop, pause and resume,
progress, and downloads that start from a selected remote file. An upload is
complete only when the device confirms its atomic target commit. Transfer
metadata and blocks keep the existing 24-hour expiry and storage cleanup policy.

Guided actions accept only absolute local paths. They reject these items:
network shares, alternate data streams, paths that are ambiguous or contain
traversal, agent data, ancestors of the agent directory, reparse points and
hardlinked files. The agent holds ancestor directory handles without delete
sharing. Rename and delete operate on the verified open object handle.

Rename never overwrites a different entry. Folder deletion is not recursive.
Folders that are not empty and locked files stay as they are. These limits
apply to the guided browser and to transfers. Management terminals have no
such limits.

Validate the native Windows file system behavior (sharing, links, permissions
and locked files) on Windows Server 2022/2025 and Windows 11. The Linux
build checks the compilation. The portal tests check admission, scope,
ownership and result handling without a connection to a Windows computer.
