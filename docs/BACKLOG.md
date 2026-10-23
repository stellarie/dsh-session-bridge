# Backlog

Audience: the maintainer, choosing what to pick up next.
IDs are stable. Append new items. Never renumber.

| ID | Item | Why |
|---|---|---|
| 1 | Make the `preset` argument of `dsh_open_session` configurable. Today it defaults to `yuu`. | Other users have no `yuu` preset. They must pass `preset` on every call. |
| 2 | Record a live `turn/end` event and replace the type-derived fixture in `tests/fixtures/session-page.json`. | The wait logic relies on event shapes read from types. |
| 3 | Fail soft when the plugin starts before the web server listener binds. | `getOrigin()` throws before listen. The plugin effect then fails. |
| 4 | Stop `dsh_wait` from ending on a turn left over from earlier queued work. | The wait returns on any `turn/end` after `afterSeq`. |
| 5 | Set the effort of one session without saving it as the app default. This needs a host change. | `selectModel` also saves the selection as the app default. Every `dsh_open_session` rewrites it. |
| 6 | Read the model a preset pins and keep it when `dsh_open_session` sets effort. | The bridge selects the catalog default model. That can replace a model that the preset chose. |
