# Effect/Solid comparison, 2026-09-05

The committed experiment substantially reduces CPU work for message updates. This comparison also found increased memory use and rebuilding of text inside unchanged message bubbles on appends. The subsequent rendering fix is described below; the memory increase is retained as an accepted tradeoff.

The original comparison used `be38f92` and `b405c45` without changing application code. The rendering follow-up below compares `b405c45` with the subsequent working-tree fix.

## Method

- Production builds with `VITE_TELEVECHA_E2E=1`, using the same existing Telegram fixture transport and engine code. No development server, live Telegram network, or artificial CPU throttling.
- Headless Chromium 151.0.7922.34 on Linux, Intel Core i7-13700K, 1440 × 1000 viewport, reduced motion.
- Three accepted pairs, with both run orders represented. Every run starts with a fresh browser context and storage. An additional pair overlapped local lint/type validation and was excluded in full.
- Load all 1,000 messages through the real history pagination UI, edit one message 20 times, append ten bursts of 20 messages, then deliver ten updates to another chat.
- Warm Alice and Release Channel, then repeat 20 cycles of switching between them, searching messages, and opening shared photos. Compare transport counters and memory after cycles 0, 5, 10, and 20.
- CPU time is Chromium's renderer `TaskDuration` delta through two animation frames after the expected DOM result. It includes scripting, layout, and benchmark instrumentation. DOM-ready latency ends when a MutationObserver sees the requested result; it is not a paint timestamp.
- DOM observations cover the conversation subtree and existing article-node identity. Heap measurements follow explicit garbage collection and exclude native/GPU memory.

The timing table reports the median of the three per-run medians. Raw observations come from [the benchmark runner](../scripts/benchmark-ui.mjs). These are desktop fixture measurements, not a claim about mobile performance or Telegram network latency. The large-chat workload renders every loaded message; initial chat entry normally loads only 50.

## Renderer CPU time

| Operation                                             |   Baseline | Experiment |  Change |
| ----------------------------------------------------- | ---------: | ---------: | ------: |
| Load another 50 history messages                      |   100.2 ms |    74.3 ms |    −26% |
| Edit one message among 1,000                          |    91.3 ms |    32.4 ms |    −65% |
| Append a burst of 20 messages                         | 4,345.6 ms | 1,862.7 ms |    −57% |
| Update an inactive chat while 1,200 messages are open |    58.2 ms |    21.1 ms |    −64% |
| Switch between warmed chats                           |    28.0 ms |    22.0 ms |    −21% |
| Submit a message search                               |     8.1 ms |     9.1 ms | +1.0 ms |
| Open shared photos                                    |    40.2 ms |    39.4 ms | −0.8 ms |

The large-update gains held across runs. Edit medians were 90.9–93.4 ms on the baseline and 32.3–33.2 ms on the experiment. Burst medians were 4,318–4,350 ms and 1,851–1,866 ms respectively. Small navigation differences deserve less weight than these consistent update gains.

Median DOM-ready latency also improved: edits went from 88.1 to 30.6 ms, bursts from 4,345 to 1,914 ms, and inactive-chat updates from 50.6 to 14.0 ms. Warm chat switching went from 11.0 to 9.4 ms. Search and shared-photo DOM readiness stayed around 8 ms and 4 ms respectively.

An additional sampled CPU profile found substantial baseline time in `formatMessageTime`, which constructs `Intl.DateTimeFormat` repeatedly while projecting unchanged messages. The experiment's projection cache avoids that repeated work. This comparison measures the entire branch; it does not demonstrate that Effect field atoms themselves caused the gains. Structural sharing and the Solid subscription machinery still consume CPU in the experiment.

## DOM work still needs attention

Both versions retained all 1,000 existing article nodes during single-message edits. Edits produced a median of two conversation mutations, and inactive-chat updates produced none. Appends also retained existing articles.

However, the append workload produced the same median **44,020 mutation records per burst** in both versions. A separate diagnostic on the first burst located them precisely:

| Mutation target                              | Baseline | Experiment |
| -------------------------------------------- | -------: | ---------: |
| Child-list mutations inside `p.message-body` |   40,380 |     40,380 |
| New conversation rows                        |       20 |         20 |
| Row class mutations                          |       20 |         20 |

Article identity therefore hid a deeper problem: unchanged message text spans are removed and recreated. In [App.tsx](../src/ui/app/App.tsx), each message's `layout()` directly reads the shared `messageRows()` computation, and `MessageBody` receives `layout().caption`. In [MessageBody.tsx](../src/ui/conversation/MessageBody.tsx), `textParts(props.message)` creates fresh objects for its `<For>`. A list update can invalidate that path despite an unchanged caption.

This identified the need to stabilize each row's layout/caption dependency and preserve unchanged text parts. Article identity alone did not establish granular rendering. The roughly two-second burst processing also warranted attention to repeated layout/scroll work.

## Memory and cache behavior

| State, after garbage collection                       | Baseline heap | Experiment heap |
| ----------------------------------------------------- | ------------: | --------------: |
| 1,000 messages loaded                                 |      68.6 MiB |        84.3 MiB |
| 1,200 messages after the bursts                       |      81.0 MiB |        99.7 MiB |
| After leaving the large chat and 20 navigation cycles |      19.1 MiB |        37.1 MiB |

The loaded-chat cost is about **23% more heap**. Navigation heap growth largely leveled off between cycles 10 and 20. Both versions stabilized at the same DOM-node and event-listener counts; no continuous growth was demonstrated by this bounded test.

The first measurements waited 35 seconds for the nominal 30-second idle TTL. Reading the installed Effect registry implementation showed that its default sweep resolution is half the TTL, allowing removal to occur up to 45 seconds after becoming idle. That explains why the experiment's 35-second measurements varied between 31.6 and 37.0 MiB.

A follow-up using one burst and three warm-up chat switches measured both versions again after **50 seconds idle**. Heap was 17.8 MiB on the baseline and 30.5 MiB on the experiment, leaving **12.6 MiB extra** after the sweep. The retained state differs from the full 20-cycle workload, so these values are a separate comparison. The runner now includes both 35- and 50-second samples.

The likely retention source is the message-view cache. Both versions retain up to 800 inactive views, but the experiment's views additionally retain per-field atoms and Solid observations until eviction or app disposal. This bounded increase is accepted for now; no memory-cache redesign is included in the rendering fix.

Across all three accepted pairs, repeated chat navigation made **no additional history requests**. Each version performed 20 search queries, 20 shared-media queries, and one additional media download for content first opened in shared photos. Subsequent uses reused the media cache. Avatar requests stayed unchanged in all experiment runs and two baseline runs; the remaining baseline run recorded one additional request. That single difference is insufficient evidence of improved caching. All accepted runs completed without uncaught page errors.

## Rendering follow-up

Each rendered row now memoizes its layout and caption separately. An unchanged caption no longer invalidates `MessageBody` when list membership, sender-group layout, or history indices change. Actual edits still update through the message's field subscriptions. Compact row spacing is now part of the layout calculation, replacing each row's repeated copying and scanning of the remaining layout array.

A new browser regression failed against `b405c45` when an append replaced a revealed spoiler. It now passes for both appends and history prepends, preserving text-node identity and spoiler state. The same test verifies that a real edit updates the text and creates a newly hidden spoiler. Layout tests cover spacing across hidden album rows and sender/date boundaries.

One paired production-build confirmation used the same 1,000-message rendering workload against `b405c45` and the fix. Navigation cycles and idle waits were omitted; this was not another memory study.

| Operation                                   | Before fix |  After fix |
| ------------------------------------------- | ---------: | ---------: |
| Median DOM mutations per 20-message burst   |     44,020 |         40 |
| Median removed nodes per burst              |     21,990 |          0 |
| Median renderer CPU per burst               | 1,902.9 ms | 1,256.8 ms |
| Median DOM mutations per older-history page |      1,054 |         54 |
| Median renderer CPU per older-history page  |    75.6 ms |    59.5 ms |
| Median renderer CPU per single-message edit |    33.9 ms |    35.0 ms |

The burst's remaining mutations are 20 appended rows and 20 spacing-class changes. Existing articles remain mounted, and the regression verifies preservation of their text content nodes. The large DOM-work reduction is the principal result; the single timing pair is a confirmation rather than a new multi-run performance study. Full-array processing still remains.

Validation passed: formatting, lint/types, browser-test types, all 295 unit tests, and 77 browser tests covering rendering stability, history, rich content, incoming/outgoing media, and mobile navigation. The production build also passes. The existing view/cache memory policy is unchanged.

## Reproduce

Use the existing installed dependencies for both checkouts:

```sh
git worktree add --detach /tmp/tv-baseline be38f92
ln -s "$PWD/node_modules" /tmp/tv-baseline/node_modules
(cd /tmp/tv-baseline && VITE_TELEVECHA_E2E=1 ./node_modules/.bin/vp build --outDir /tmp/tv-baseline-dist)
VITE_TELEVECHA_E2E=1 npx vp build --outDir /tmp/tv-experiment-dist
node scripts/benchmark-ui.mjs /tmp/tv-baseline-dist /tmp/tv-experiment-dist /tmp/tv-results.json 3
```

Run the experiment build from `b405c45` to reproduce this revision. Run builds and validation before collecting measurements. The runner serves both build directories locally, runs browsers sequentially, writes per-action results and memory/counter snapshots to JSON, and closes its browser and servers afterward. It does not contact Telegram or alter application data in your regular browser.
