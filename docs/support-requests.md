# Support requests

*Added in v0.20.*

A customer who needs help can ask for it without an account, and the request lands in a queue that the right technicians work. This is a lightweight intake and queue, not a ticketing system. There are no comments, SLAs or integrations, and requests are erased after a month.

## For the customer: the support link

A Business Owner turns this on at **Customer Settings → Customer support link**. That creates a link of the form

```
https://<your server>/support/<16 random characters>
```

which can be shared with the customer's staff, put on an intranet page or a desktop shortcut. **The link is the only thing that picks the customer**, so anyone with the link can submit a request to that customer. Regenerating it invalidates the old one at once. Turning it off makes the link answer exactly as an unknown link does, so a disabled link cannot be told apart from one that never existed.

Signed-in members of a customer can also ask from **Devices → My devices → Request support**, which can name one of their own devices.

## From the tray on a Windows device (0.36)

The [tray icon](tray.md) on a managed Windows device has **Open a support request…**. A request sent from it:

- arrives in the same queue, labelled *The tray on the device*;
- is already linked to the device;
- is signed with the Windows account that sent it.

The person can tick two boxes, both unticked by default: one attaches their current **resource usage** and the
other a **screenshot**, which they see before sending and can remove. Starting a chat from the tray also puts a
request in the queue.

The limits are 3 requests an hour per device, 2 an hour per Windows account, and 3 open at a time per device.
Containment never blocks a request.

**Attachments are shown only to someone who can see the device** as well as the queue. Anyone else sees the
request and a note such as *2 attachments are hidden because you cannot see this device*. Attachments are deleted
when the request is anonymised, and in any case **45 days** after they were sent, even if the request is still
open.

Requests from the tray are **not sent to ClientSt0r**. No support request is today, from any origin. A signed
`support_request.created` event (ids, the device, the customer, a short redacted subject and whether usage or a
screenshot was attached; attachments only by a separate authenticated read) is proposed to ClientSt0r as contract
revision 5 and is not agreed or built (`INTEGRATION_COORDINATION.md` §5B, 0.36.1).

## What the customer sees

The form asks for a name, contact details, a description, and optionally the RustDesk ID on their screen. After submitting, they get a **status link** to keep. It shows only the status in plain words ("waiting for a technician", "a technician is on it") and the technician's first name. It never shows a computer name, an email address or anything about any other request. The customer can cancel while the request is still waiting or claimed. Status links stop working after 7 days.

## Abuse limits

The form is unauthenticated, so it is limited in layers:

- 5 submissions per minute per address (HTTP 429 beyond that);
- at most 3 open requests per address, and 25 per customer;
- a hidden honeypot field, plus a minimum time to fill the form. A bot that trips either is told it succeeded, and nothing is stored;
- the address is stored only as a keyed hash, used for the per-address cap.

## For technicians: the queue

**Remote support → Support requests** (needs `support:requests`) lists the customer's requests. A technician working through an assignment sees the queue for the customer they are switched into.

- **Claim** a request to take it. Claiming is atomic: if two people claim at once, one wins and the other is told who has it.
- **Hand off** to someone else who can handle requests in that customer. Only people who hold `support:requests` there, as members or through an assignment, are offered.
- **Release** puts it back in the queue. **Complete** or **Cancel** closes it.
- **Matched devices**: when the description or RustDesk ID matches devices in the customer, they are listed, but only devices *you* can connect to.
- **Connect** is offered to the claimer only, through the normal Connect button for a managed device or Quick Connect (which records the request on the session).

A request still `WAITING` after 24 hours expires. Closed requests are anonymized after 30 days, which removes the name, contact details and description, and deletes any screenshot or usage attachment.

## See also

- [The tray icon](tray.md)
- [Technician guide](technician-guide.md)
- [Access control](access-control.md)
