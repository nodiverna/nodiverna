# Manufacturer logos

The device **Overview**, **Hardware → System** and the optional **Manufacturer** column of the device list show the manufacturer that a device reports. A known manufacturer shows its logo next to its name. Refer to [Device areas](device-workspace.md#manufacturer).

## Source

The logo paths come from Simple Icons (<https://simpleicons.org>), npm package `simple-icons` version `16.38.1`. ServerDesk copied the paths one time into `ui/devices/hardware/manufacturer-logos.ts` and did not change them. Each path uses the `viewBox` `0 0 24 24`. The package is not a dependency of ServerDesk.

## License

The Simple Icons icon data uses the CC0-1.0 license. Simple Icons gives a separate license for some icons. None of the icons in the table below has a separate license in version `16.38.1`.

ServerDesk does not use the brand colors of Simple Icons. Each logo shows in one color, the text color of the console, and always next to the manufacturer name.

## Trademark notice

The logos are trademarks of their owners. Nodiverna shows them only to identify the manufacturer that a device reports. This use does not mean that an owner endorses or is affiliated with Nodiverna.

## Manufacturers

ServerDesk compares the reported value in lower case with each row, and the first row that matches applies. HPE comes before HP, so `Hewlett Packard Enterprise` does not show as HP. Other values show their name with a neutral icon. Empty values and BIOS placeholders, for example `To be filled by O.E.M.`, show as not reported.

| Id | Name | Simple Icons slug |
|---|---|---|
| `hpe` | HPE | none |
| `hp` | HP | `hp` |
| `dell` | Dell | `dell` |
| `lenovo` | Lenovo | `lenovo` |
| `asus` | ASUS | `asus` |
| `acer` | Acer | `acer` |
| `msi` | MSI | `msi` |
| `fujitsu` | Fujitsu | `fujitsu` |
| `supermicro` | Supermicro | `supermicro` |
| `gigabyte` | GIGABYTE | none |
| `samsung` | Samsung | `samsung` |
| `toshiba` | Toshiba | `toshiba` |
| `intel` | Intel | `intel` |
| `vmware` | VMware | `vmware` |
| `qemu` | QEMU | `qemu` |
| `virtualbox` | VirtualBox | `virtualbox` |
| `cisco` | Cisco | `cisco` |
| `huawei` | Huawei | `huawei` |
| `panasonic` | Panasonic | `panasonic` |
| `google` | Google | `google` |
| `microsoft` | Microsoft | none |
| `apple` | Apple | none |
| `dynabook` | Dynabook | none |
| `medion` | Medion | none |
| `wortmann` | Wortmann | none |
| `xen` | Xen | none |
| `amazon` | Amazon EC2 | none |

## Manufacturers without a logo

- `hpe` and `gigabyte`: version `16.38.1` of Simple Icons has no `hewlettpackardenterprise` and no `gigabyte` icon.
- `microsoft` and `apple`: the trademark guidelines of Microsoft and Apple do not allow this use of their logos. They never get a logo.
- `dynabook`, `medion`, `wortmann`, `xen` and `amazon`: Simple Icons has no logo for them.

A Hyper-V machine reports `Microsoft Corporation`, so it shows the neutral icon and the name **Microsoft**.

## Update the logos

1. Get the new package with `npm pack simple-icons@<version>` in an empty folder.
2. Copy the single path of each `icons/<slug>.svg` without changes.
3. Change the version in the header of `manufacturer-logos.ts` and in this file.
4. Remove a row whose slug the new version does not have, and set its slug to none.
5. Run `node tests/ui/devices/manufacturer-model.mjs`.
