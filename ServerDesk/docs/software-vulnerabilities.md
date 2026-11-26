# Software vulnerabilities

The vulnerability check compares the software inventory of your devices with known vulnerabilities (CVEs). It shows which installed programs have a known vulnerability, how severe it is, and to which version you must update. The check is off by default. Only an owner can turn it on.

This product uses data from the NVD API but is not endorsed or certified by the NVD.

With the CVE.org source, the check also uses CVE data from the CVE Program (cve.org), retrieved through CIRCL Vulnerability-Lookup. Refer to [CVE Program terms of use](#cve-program-terms-of-use).

## Source

The NVD is the base of the check. The portal downloads the CVE data from the National Vulnerability Database (NVD) of NIST. It uses the NVD CVE API 2.0. The NVD data also contains the flag of the CISA catalog of known exploited vulnerabilities.

The NVD analyzes new CVEs with a delay of some days, and since 2024 it has a large backlog. Thus, a new CVE shows only after the NVD adds its product data. For this reason, an owner can turn on CVE.org as an optional second source. Then a CVE can show on the day that the vendor publishes it.

The CVE List of the CVE Program contains the CVE records of the vendors (CNAs), with the affected versions. On many records, the CISA ADP adds CPE names, a CVSS score and the known exploited flag. CVE.org has no search by product. Thus, the portal reads the records through the API of CIRCL Vulnerability-Lookup.

When both sources have a CVE for a product, the NVD wins. The portal then uses only the versions of the NVD for this product. The severity, the CVSS score and the known exploited flag also come from the NVD when the NVD has the CVE. The CVE.org data counts only for products that the NVD synchronized at least one time.

The portal keeps the CVE data in its own database tables. It compares the data with the inventory when you open a view. It does not send inventory data to the NVD or to CIRCL.

## What the portal sends

For each product in the catalog, the portal sends one request to `https://services.nvd.nist.gov/rest/json/cves/2.0`. The request contains only these values:

- `virtualMatchString` with the vendor and the product of the catalog entry, for example `cpe:2.3:a:google:chrome`.
- `resultsPerPage`, `startIndex` and `noRejected`.
- `lastModStartDate` and `lastModEndDate` for an update of the changes since the last check.
- The header `User-Agent: ServerDesk/<version>`, and the header `apiKey` when you saved a key.

When the CVE.org source is on, the portal also sends requests to `https://vulnerability.circl.lu/api/vulnerability/cpesearch/`. Each request contains only these values:

- The path with the vendor and the product of the catalog entry, for example `cpe:2.3:a:google:chrome`.
- `source=cvelistv5`, `date_sort=updated`, `sort_order=desc`, `per_page=100` and `page`.
- The header `User-Agent: ServerDesk/<version> (+https://github.com/nodiverna/nodiverna)`. CIRCL asks for a contact URL in the User-Agent. The portal sends no API key to CIRCL.

The portal asks for every product in the catalog, also for products that no device has. Thus, a request tells nothing about your devices. The portal never sends device names, versions, customer data or other inventory data.

## Turn on the check

1. Open **Settings → Vulnerability check**.
2. Turn on **Check installed software against the NVD**.
3. Optional: turn on **Also check against the CVE.org list**. This switch works only while the check is on.
4. Optional: paste your NVD API key into **NVD API key (optional)**.
5. Select **Save**.

The first check starts within one minute. Without a key, it takes about five minutes. The card **Status** shows the state, the last successful check, the next check and the number of CVEs for each product. **Check now** starts a check within one minute.

While the CVE.org source is on, the card **Status** also shows **Last CVE.org check** and the column **Only on CVE.org**. This column counts the CVEs of a product that only CVE.org lists.

When you turn off the CVE.org source, the views show only the NVD data again. The portal sends no more requests to CIRCL. The stored CVE.org data stays in the database.

When you turn off the check, the portal stops the checks and hides all results. A check that runs at that time stops before its next request to the NVD. The stored CVE data stays in the database. When you turn on the check again, the next check continues with the products that the stopped check did not complete.

## API key

The NVD limits the requests. Without a key, the portal waits at least 6 seconds between two requests. With a key, it waits at least 0.7 seconds. Thus, a check with a key is about ten times faster. You can request a key on the [NVD website](https://nvd.nist.gov/developers/request-an-api-key).

The portal encrypts the key with the session secret, like the secrets of notification channels. The key never leaves the server, and no log or audit entry contains it. After a change of `SESSION_SECRET`, the command `rewrap-secrets` encrypts the key again ([self-hosting.md](self-hosting.md#change-the-session-secret)).

## Schedule and errors

The check runs one time each day and after **Check now**. The first check of a product downloads all its CVEs. Later checks download only the CVEs that changed since the last check, with one hour of overlap. Each 7 days, the portal downloads all CVEs of a product again and removes CVEs that the NVD does not list any more. After an update with changed matching rules, the next check downloads all CVEs of all products again. This check starts within one minute.

If a request fails, the check stops and the stored data stays. The card **Status** shows the cause, for example that the NVD limited the requests. If the portal cannot save the CVE data in the database, the check also stops and the card shows this cause. The next check starts after one hour, or at once after **Check now**. When the check is interrupted, the next check continues with the next product.

The CVE.org part of a check runs after the NVD part, in the same check. It has its own schedule: one time each day, and after **Check now**. The first CVE.org check of a product reads the records that changed in the last 365 days. Later checks read only the records that changed since the last check, with one hour of overlap. Each 7 days, the portal reads the last 365 days again and removes the CVE.org data that it did not read again.

CIRCL allows 20 requests each minute without a key. Thus, the portal waits 3.5 seconds between two requests to CIRCL. A page has 100 records, and the portal reads a maximum of 100 pages for each product.

If the CVE.org part fails, the NVD results stay, and the NVD state stays **Waiting for the next check**. The card **Status** shows the cause of the CVE.org failure in a separate notice. The next CVE.org check starts after one hour, without a new request to the NVD.

The check runs in the portal process, on its own schedule. It does not delay the alarm check or the notifications. With many replicas, only one replica checks at a time. With `MAINTENANCE_SCHEDULER=off`, the portal does not run the check.

## Outbound access

The portal needs outbound HTTPS access to `services.nvd.nist.gov` on port 443. With the CVE.org source, it also needs `vulnerability.circl.lu` on port 443. The portal follows no redirects. It stops a request after 60 seconds and refuses a response that is larger than 32 MiB. If the portal cannot reach the host, the state is **Failed** with a message about the connection.

## Catalog

The portal checks only programs from a catalog of common Windows products: `lib/vulnerability-catalog.json`. Each entry has the vendor and the product of the NVD, the program names from the uninstall keys of Windows, and optional publisher names. The catalog contains browsers, archive tools, editors, remote access tools, PDF readers and server components. For example, it contains Google Chrome, Microsoft Edge, Mozilla Firefox, 7-Zip, Notepad++, PuTTY, VMware Tools and PostgreSQL. The settings page shows the full list and the date of the last catalog check.

To propose a product, open an issue or a pull request. Give the program name and the version from the uninstall key of a real device, and the NVD vendor and product. The version format of the program must compare with the versions in the NVD.

## Results

- The device area **Software → Programs** shows the column **Vulnerabilities**. The view **Vulnerabilities** shows only the programs with a known vulnerability, the most severe first.
- The report **Inventory → Software** of all devices, a group or a customer shows the same column. The filter **Vulnerable** shows only the products with a known vulnerability. The CSV export adds the highest severity, the number of CVEs, the known exploited flag and the fixed version.
- Select a severity to see the CVEs. Each CVE has a link, the severity with the CVSS score, the source, the date and a summary. The recommendation tells you to which version you must update. If the NVD gives no fixed version for a CVE, update to the latest version or read the advice of the vendor.
- The source of a CVE is **Source: NVD** or **Source: CVE.org**. The link of the CVE opens it at its source: on the NVD website or on `www.cve.org`.

**None known** means that no CVE in the stored data affects this version. **Not checked** means that the program is not in the catalog or that its version is not known. It also shows before the first check is complete. If the last successful check is older than 72 hours, the views show a warning.

## Matching rules and limits

- The portal matches the normalized program name exactly or by a prefix from the catalog. It does not search the NVD product dictionary, because this gives wrong matches.
- The portal compares the version numbers segment by segment. `1.10` is newer than `1.9`, and `23.01` is equal to `23.1`. The inventory keeps only the numeric part of a version, so `1.1.1w` becomes `1.1.1`.
- The portal uses only the NVD configurations for applications on all platforms or on Windows. A configuration for more than one operating system counts when Windows is one of them. A vulnerability that occurs only on another operating system, for example on iOS, does not count.
- Some NVD entries have no version data, so they apply to all versions. Such an entry counts only for 365 days after the CVE was published. The NVD keeps these old entries also when all current versions are safe, for example CVE-2012-4929 for Google Chrome.
- The NVD analyzes new CVEs with a delay. Without the CVE.org source, a new CVE can show only after the NVD adds the product data.
- A CVE.org record counts for a product when one of its affected entries matches the product. The entry can come from the vendor (CNA) or from an ADP, for example the CISA ADP.
- An entry matches by a CPE name with the vendor and the product of the catalog. It also matches by a vendor and product pair in `cveNames` of the catalog entry, for vendor names that differ.
- An entry also matches by a program name of the catalog. Then its vendor must be empty, `n/a`, the vendor of the catalog or one of the publishers. Thus, a fork with the same product name, for example 7-Zip from another vendor, does not count.
- An entry whose platforms do not include Windows does not count.
- Only versions with the status `affected` count. The portal reads `lessThan` and `lessThanOrEqual`, an exact version, and simple expressions such as `< 25.0.0` or `>= 9.11, < 26.01`. It also reads `16.02 and earlier` and `before 5.4`.
- An entry without version data never counts, also when its default status is `affected`. Free text such as `24.08 (x64)` and a lower bound alone also do not count. Thus, a CVE.org record never applies to all versions.
- The check covers programs, not Windows. Windows updates stay with **Windows Update**.

## CVE Program terms of use

The CVE.org data is available under the [CVE Program terms of use](https://www.cve.org/Legal/TermsOfUse). These terms let you copy and distribute the CVE data. Each copy must keep the copyright designation of MITRE and the license text. The portal keeps a copy of the CVE.org records of the catalog products in its database. Thus, this page gives the attribution and the license.

```text
CVE data: Copyright The MITRE Corporation. CVE is a trademark of The MITRE Corporation.
Retrieved through CIRCL Vulnerability-Lookup (https://vulnerability.circl.lu).

CVE Usage: MITRE hereby grants you a perpetual, worldwide, non-exclusive,
no-charge, royalty-free, irrevocable copyright license to reproduce, prepare
derivative works of, publicly display, publicly perform, sublicense, and
distribute Common Vulnerabilities and Exposures (CVE). Any copy you make for
such purposes is authorized provided that you reproduce MITRE's copyright
designation and this license in any such copy.
```

The settings page shows the short attribution under the NVD notice while the CVE.org source is on. CIRCL asks its clients not to mirror its data set. The portal reads only the records of the catalog products.

## Rights

Only an owner can open the settings page and change the check. Each change makes one audit entry, for example `Vulnerability check turned on`, `CVE.org source turned on` or `NVD API key saved`. All users who can see a device see its results. The report **Software** counts only the devices that you can see, inside your customer boundary.
