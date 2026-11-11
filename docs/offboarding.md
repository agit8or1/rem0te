# Access review and offboarding

*Added in v0.20.*

When someone leaves, two questions matter: who can still reach a computer, and what did the person who left already have. Rem0te answers both from the same rules that decide every connection, and is explicit about what it **cannot** undo.

## What revocation can and cannot do

This is the most important part of the page.

- **Removing access stops new connections through Rem0te at once.** Memberships, grants and assignments are re-read on every request and every token redemption.
- **It does nothing to a RustDesk password the person already saw.** RustDesk accepts the permanent password directly, from any RustDesk client, with no Rem0te involvement. If the person revealed a computer's password, or connected in a way that released it, that password keeps working until it is changed.
- **Rotation is how it is changed.** A new password is staged; the computer applies it on its next check-in (every 3 minutes) and confirms. **Until it confirms, the old password still works**, and Rem0te shows the rotation as *pending*, never as done. An offline computer stays pending until it comes back.
- **Neither ends a RustDesk session that is already open.** End it on the computer.

## Access review

Every computer has an **Access review** panel, *Who can connect to this computer* on its **History** tab (needs `users:view`). It lists everyone who can connect, and how:

| Shown as | Meaning |
|---|---|
| Platform Admin | every computer on the server |
| Business Owner | every computer in the business |
| Granted access | a per-computer grant |
| Company-wide | the computer is company-wide and the person has `computers:connect` |
| Technician (direct / via group) | an [MSP technician assignment](technicians.md) |

Each entry says whether it works **right now**. If not, it gives the reason: membership disabled, no connect permission, not started, expired, outside its schedule, or pending approval. Temporary entries show their end.

## Offboarding someone

**Offboarding** (Business Owners in their own business, and Platform Admins). Pick a person; the preview shows, before anything changes:

- what will be revoked: membership, per-computer grants, technician assignments, group memberships, unredeemed launcher tokens and connection grants;
- **the credentials they obtained**: every computer whose password they revealed (refused reveals are excluded), or that released its credential when they connected, with when and how;
- **shared passwords**: other computers in the business that use the same password as one they had, including computers they never touched;
- whether the account itself can be suspended.

Running it (needs step-up, `permissions.change`) does, in order: disable the membership, optionally suspend the account and end every signed-in session, remove grants, revoke assignments, revoke unredeemed tokens, and stage rotation for each computer you ticked. Everything that will be rejected (a suspension not allowed, a computer not on the list) is refused **before** anything changes.

### Scope

- **A Business Owner** offboards a person from **their** business only. The account is suspended only if this business is all the person has. Someone who also works elsewhere keeps their account, and only a Platform Admin can suspend it.
- **A Platform Admin** (or a holder of `technicians:manage`, for a technician account) can offboard everywhere: every membership, assignment and group, and every token.
- Access through a **technician group** is not removed by a business-level offboarding. The preview says so; remove the person from the group, or revoke the group's assignment.

### Afterwards

The case page shows each step and the **live** status of every rotation: pending (online, waiting for a check-in), pending (offline: the old password works there until it returns), confirmed, or failed. The case is marked complete only when every rotation is confirmed. **Offboarding → Pending rotations** lists every computer in the business whose staged password has not been acknowledged, whoever staged it.

## See also

- [Access control](access-control.md)
- [Technicians](technicians.md)
