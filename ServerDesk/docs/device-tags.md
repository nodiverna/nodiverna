# Device descriptions and tags

A device can have a short description. Devices and device groups can have tags.
A tag is a pair of a name and a value, for example `Environment` and
`Production`. Use tags to sort and find devices. Later releases will also use
tags as targets for alert rules, notifications and runbooks.

## Description

The description is free text for people, for example the department, the room
or a contact person. It shows in one line below the device name in the page
header. A long text ends with an ellipsis. Point to the text to see the full
text.

If the text is too long for the line or has line breaks, select it to expand
it. Select it again to collapse it. The **Overview** area has no
description card.

To change the description, do these steps:

1. Open the device.
2. Select the pencil icon next to the description, or **Add description**.
3. Write the text.
4. Select **Save**.

These rules apply to the text:

- The maximum length is 500 characters. An emoji counts as one character.
- Line breaks stay. Spaces at the start and at the end are removed.
- HTML tags and control characters are not permitted. Text such as `a < b` is permitted.
- An empty text removes the description.

Only the portal writes the description. The agent never sends or changes it.
When you remove a device from the portal, ServerDesk also deletes its
description, because the text can contain personal data.

## Tags on devices and groups

The tags of a device show below the device name in the page header, after the
description. Each tag is a chip with the text `Name: Value`, or `Name` without
a value. The chips are sorted by name.

- To add a tag, select **Add tag** after the chips. Write the
  name and, if necessary, the value. Then select **Add tag**
  again. **Cancel** or the Esc key closes the form and keeps the tags.
- To remove a direct tag, select the remove button (X) on its chip. ServerDesk
  removes the tag immediately, without a confirmation.
- An inherited tag has a dashed border and no remove button. After the tag text,
  the chip shows **Inherited** and the name of the origin group. If you can see
  that group, the group name is a link. Select it to open the page **Configuration → Tags** of
  the group. A screen reader reads the tag, the group and where you can change it.

The tags of a device group are on the page **Configuration → Tags** of the group. Select
**Add tag** above the cards to add a tag.

The card **Direct** shows the tags of
the group. A direct tag that applies to the subgroups and devices shows
**Passes down** after its name. The card **Inherited** shows the tags of the
parent groups, the nearest origin first, each with its origin. It shows only
when such tags exist. **All devices**, **Ungrouped**
and customers have no tags.

When the group has no direct tag, the card **Direct** tells you so and shows
**Add tag**. When no tag applies at all, it shows **No tags**.

These limits apply to each device and each group:

- A maximum of 50 tags.
- A name has 1 to 64 characters. A value has 0 to 256 characters. An empty value means that the tag has no value.
- Names are unique without regard to case. Thus `Umgebung` and `umgebung` are the same name.
- ServerDesk removes spaces at the start and at the end of a name and of a value. Control characters are not permitted.

## Inheritance

A group tag can apply to all subgroups and devices of the group. To do this,
enable **Inherit to subgroups and devices** on the group tag. This switch is off by default. Device tags are never
inherited.

When two tags have the same name, the nearest tag wins. The sequence is the
device, then its group, then the parent groups from near to far. A group tag
without inheritance applies only to the group itself. It does not hide an
inherited tag of a parent group from the subgroups and devices.

On the page **Configuration → Tags** of a group, a direct tag that hides an inherited tag shows
**Changed** and the inherited value. In the device header,
this tag has an accent color. Point to it to see the inherited value. **Reset to inherited value** removes the direct tag. You can change an inherited tag only at its
origin. The origin link opens the page **Configuration → Tags** of the origin group, if you can
see that group.

ServerDesk calculates the inheritance each time that it reads the tags. When
you move a device to a different group, its tags change immediately.

## Rights

To change the description or the tags of a device, you need the right
**Manage device groups and permissions**
on the device. A role assignment on the device, on one of its groups or on all
devices gives this right. For group tags, you need this right on the group or
on a parent group. To read tags, the right to view the device or group is
sufficient.

Changes stay in the customer boundary. Each change writes an entry to the
access log. The entry has the old and the new value.

## Device list, filter and export

The device list has the columns **Description** and **Tags**. They are off by
default. Turn them on in the column menu.

The **Tags** column shows up to two tags and the number of other tags. Point
to the cell to see all tags. Inherited tags show their origin group. The
**Description** column shows one line. Point to the text to see all of it.

The search also finds text in the description and in tag names and values.
Select **Filters** above the list. The list **Filter by tag** selects a tag name. After you select
a name, a second list selects a value or **Any value**. The
filter compares names without regard to case and values exactly. It also finds
inherited tags.

**Reset filters** sets the device type, the state and the tag back. The search
and the status stay.

To change many devices, select them in the list. **Add tag**
sets one tag on all selected devices. If a device already has a tag with this
name, the tag gets the new value. **Remove tag** removes one
direct tag. Inherited tags stay. If one device does not permit the change,
ServerDesk changes no device.

The CSV export contains the columns **Description** and **Tags**.
The tags cell contains each tag as `Name=Value`, or as `Name` without a value.
The tags are sorted by name and separated by `; `.
