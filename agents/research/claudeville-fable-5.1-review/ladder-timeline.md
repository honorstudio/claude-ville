# GPU quality-ladder timeline (reference machine)

Captured 2026-09-01 against `main` at `e7737d5` (v0.37.0) on the maintained dev server, Apple M5 Pro, headless Chromium with `--use-angle=metal` (WebGL2 reports `ANGLE Metal Renderer: Apple M5 Pro`), 1920x1080, DPR 1, `?sim=1&scenario=dense-24-agents`, hour fixed at 23:00. One sample per second from `window.__claudeVillePerf.frameHealth()`; `q` is `qualityLevel` (0 = FULL, 1 = REDUCED, 2 = MINIMAL, 3 = DISABLED, which still draws at MINIMAL). Script: `ladder-probe.mjs`.

```
2s q=2 within-budget gpu=2.08 render=2.7 gap=8.4 lights=null
5s q=2 within-budget gpu=2.13 render=3.8 gap=8.4 lights=null
8s q=2 healthy-probe gpu=1.11 render=2.9 gap=7.8 lights=null
11s q=1 healthy-probe gpu=1.73 render=3.6 gap=8.3 lights=null
14s q=1 within-budget gpu=2.16 render=3.2 gap=8.3 lights=null
17s q=1 within-budget gpu=2.02 render=4.1 gap=8 lights=null
20s q=1 over-budget:gpuMs gpu=4.66 render=3.5 gap=8.2 lights=null
23s q=1 healthy-probe gpu=1.62 render=4.6 gap=7.5 lights=null
26s q=1 healthy-probe gpu=1.49 render=15.5 gap=10.5 lights=null
29s q=0 within-budget gpu=2.42 render=3.6 gap=8.7 lights=null
30s q=0 within-budget gpu=1.17 render=6.1 gap=11.1 lights=null
31s q=0 within-budget gpu=0.62 render=3.6 gap=8.3 lights=null
32s q=0 within-budget gpu=1.44 render=5.2 gap=8.1 lights=null
33s q=0 within-budget gpu=1.59 render=3.6 gap=7.5 lights=null
34s q=0 within-budget gpu=1.54 render=4 gap=10.5 lights=null
35s q=0 within-budget gpu=1.49 render=3.9 gap=8.4 lights=null
36s q=0 within-budget gpu=1.51 render=3.5 gap=7.7 lights=null
37s q=0 within-budget gpu=1.27 render=4.2 gap=8.5 lights=null
38s q=0 within-budget gpu=1.81 render=3.7 gap=8.4 lights=null
39s q=0 within-budget gpu=2.37 render=4.7 gap=7.8 lights=null
40s q=0 within-budget gpu=1.62 render=3.9 gap=9.3 lights=null
41s q=0 within-budget gpu=1.21 render=3.3 gap=8.2 lights=null
42s q=0 within-budget gpu=1.44 render=3.7 gap=6.3 lights=null
43s q=0 within-budget gpu=1.38 render=4 gap=8.3 lights=null
44s q=0 within-budget gpu=1.35 render=4.2 gap=7.7 lights=null
45s q=0 within-budget gpu=1.04 render=4.8 gap=8.3 lights=null
46s q=0 within-budget gpu=1.2 render=3.9 gap=8.3 lights=null
47s q=0 within-budget gpu=1.74 render=3.7 gap=7.9 lights=null
48s q=0 within-budget gpu=1.49 render=4.3 gap=5.9 lights=null
49s q=0 within-budget gpu=1.51 render=5.6 gap=10.9 lights=null
50s q=0 within-budget gpu=2.09 render=3.7 gap=10 lights=null
51s q=0 within-budget gpu=1.85 render=4.2 gap=9.2 lights=null
52s q=0 within-budget gpu=2.02 render=5.5 gap=8.1 lights=null
53s q=0 within-budget gpu=2.41 render=4.4 gap=9.4 lights=null
54s q=0 within-budget gpu=1.96 render=5 gap=8.7 lights=null
55s q=0 within-budget gpu=1.57 render=4.7 gap=9.3 lights=null
56s q=0 within-budget gpu=2.15 render=4.4 gap=7.8 lights=null
57s q=0 within-budget gpu=2.55 render=5.7 gap=10.7 lights=null
58s q=0 within-budget gpu=1.62 render=4.2 gap=9.2 lights=null
59s q=0 within-budget gpu=1.46 render=4.8 gap=7.8 lights=null
60s q=0 within-budget gpu=1.96 render=4.6 gap=7.2 lights=null
61s q=0 within-budget gpu=1.72 render=4.4 gap=9.7 lights=null
62s q=0 within-budget gpu=2.29 render=5.6 gap=8.9 lights=null
63s q=0 within-budget gpu=1.99 render=5.3 gap=8.7 lights=null
64s q=0 within-budget gpu=1.33 render=5.4 gap=8.2 lights=null
65s q=0 within-budget gpu=1.91 render=4.2 gap=9.6 lights=null
66s q=0 within-budget gpu=1.88 render=4.5 gap=11.2 lights=null
67s q=0 within-budget gpu=1.69 render=4.7 gap=8 lights=null
68s q=0 within-budget gpu=1.6 render=5.3 gap=10.1 lights=null
69s q=0 within-budget gpu=1.75 render=4.5 gap=11.8 lights=null
70s q=0 within-budget gpu=1.76 render=4.5 gap=9.1 lights=null
71s q=0 within-budget gpu=1.62 render=5.2 gap=7.7 lights=null
72s q=0 within-budget gpu=2.21 render=5 gap=10.2 lights=null
73s q=0 within-budget gpu=1.97 render=4.2 gap=6.1 lights=null
74s q=0 within-budget gpu=1.75 render=4.7 gap=9.1 lights=null
75s q=0 within-budget gpu=2.06 render=4.7 gap=9.6 lights=null
76s q=0 within-budget gpu=1.47 render=4.3 gap=8.7 lights=null

```

Reading: MINIMAL for the first 10 s, REDUCED from 11 s, one `over-budget:gpuMs` excursion at 20 s (a single 4.66 ms frame), FULL only from 29 s, then stable. The rendering reviewer's independent 26 s probe (see `rendering-review.md`, appendix) never reached FULL. This is the evidence for plan item 2.1.
