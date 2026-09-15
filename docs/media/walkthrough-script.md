# Rem0te walkthrough — script and transcript

The walkthrough is **caption-led**: the on-screen captions below are what the
recording actually shows. **No narration was produced.** The "Narration" column
is a ready-to-read script if you want to record a voice track later — it is not
present in the published video, and nothing in the repository claims it is.

Recorded against the isolated demo stack described in
[docs/screenshots.md](../screenshots.md#regenerating-these). Every business,
person and device in it is fictitious.

| # | Time | Screen | On-screen caption (as recorded) | Narration (not recorded) |
|---|------|--------|--------------------------------|--------------------------|
| 1 | 0:00 | Title card | **Rem0te** — Self-hosted remote support for customer businesses, powered by RustDesk. For MSPs and internal IT teams | Rem0te is a self-hosted remote support portal for teams that look after computers belonging to several different customer businesses. It runs on your own server, on top of RustDesk. |
| 2 | 0:06 | Sign in | Sign in — **demo environment**, fictitious businesses and synthetic devices | Everything you are about to see is a demo environment. The businesses, people and machines are invented. |
| 3 | 0:12 | Dashboard | Every customer business, computer and session in **one overview** | The dashboard is the operator's view: how many computers exist, how many are online, what is happening right now, and how much support work the last week has taken. |
| 4 | 0:17 | Dashboard — map | Client locations are plotted from each device's last known address | Client Locations plots each managed computer from the address it last checked in from, so you can see a whole customer base at a glance. |
| 5 | 0:23 | Businesses | **Workflow 1** — find a customer, then their computers | The first workflow is the everyday one. Start from the customer. |
| 6 | 0:28 | Business detail | Each business owns its own computers, people and history | A business is the boundary. Its computers, its people, its sessions and its audit trail belong to it and to nothing else. |
| 7 | 0:33 | Business → Computers | Platform, live status and last-seen for every enrolled machine | Here are that customer's machines, with platform, whether they are online, and when each was last seen. |
| 8 | 0:40 | Theme switch | Light and dark themes ship with the product | Rem0te ships both a light and a dark theme. |
| 9 | 0:45 | Enrol device | **Workflow 2** — enrol a managed device | The second workflow is putting a new computer under management. |
| 10 | 0:52 | Enrol — business | The business is fixed into the installer — the machine cannot pick another | You choose the business first, and that choice is baked into the installer. The machine that runs it cannot place itself somewhere else. |
| 11 | 0:58 | Enrol — access | Choose exactly who may connect once it is enrolled | Then you choose who is allowed to connect to it once it appears. |
| 12 | 1:05 | Access Control | **Workflow 3** — three levels: Platform Admin, Business Owner, Business User | The third workflow is access. There are three levels and no reseller hierarchy. |
| 13 | 1:12 | Business Users | Owners hold everything; each user shows the capabilities actually granted | A Business Owner controls one business completely. A Business User gets exactly the capabilities granted to them. |
| 14 | 1:20 | Quick Connect | **Quick Connect** — one-off help for a machine that is not enrolled | Quick Connect covers the other case: helping a machine that is not, and should not become, a managed device. |
| 15 | 1:26 | Quick Connect | No install, no managed computer created — it ends when they close the client | They run a small client, read you an ID and a one-time password, and the session ends when they close it. Nothing is enrolled. |
| 16 | 1:33 | Sessions | Live sessions and full history, per business | Sessions shows what is connected now, and the full history of what was done. |
| 17 | 1:41 | Audit log | Every action is written to an append-only **audit log** | Every action lands in an append-only audit log — who connected to what, from where, and when. |
| 18 | 1:48 | System status | Service health, CPU, memory and disk on the host | System Status covers the server itself: the services, and host CPU, memory and disk. |
| 19 | 1:55 | Dashboard (light) | Self-hosted. Open source. **No RustDesk Pro required.** | Rem0te is MIT licensed and runs against the open-source RustDesk server. No Pro licence, no per-technician fee. |
| 20 | 2:02 | End card | **Rem0te** — Install guide, docs and source on GitHub · github.com/agit8or1/rem0te · mspreboot.com | Install it from the guide in the repository. More free tools for MSPs at mspreboot.com. |

## Accuracy notes

- Timings are approximate and shift slightly between recordings; the caption
  text is exact.
- Every feature shown is implemented in the version recorded — see
  `version.json`. Nothing is mocked or staged beyond the demo data.
- No remote session is established at any point. The RustDesk IDs in the demo
  database are synthetic and registered with no rendezvous server.
- Enrollment tokens and RustDesk IDs are replaced in the DOM immediately before
  each frame is captured, so no usable value ever reaches the recording.
