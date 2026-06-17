# The Night Cab — vision

**The Night Cab** is a believable driver's-eye ride of a modern UK electric multiple unit —
not a game, not a toy. It earns belief two ways: **engineered correctness** (a pure, tested
simulation-and-geometry core — physics, signalling, the curvilinear world) and **sensory
fidelity** (a landscape the line genuinely threads through, weather you feel, a cab you sit
inside). Every addition must make the drive more *believable* or more *beautiful* on a core
simple enough to hold in your head. We prefer correctness we can test, detail you can see, and
restraint over feature-sprawl — when in doubt, cut. It runs anywhere a browser does, phone to
desktop, degrading gracefully.

## How to use this

A north-star for design trade-offs and saying no to scope creep. Before adding anything, ask:
does it make the drive **more believable** or **more beautiful**, and does the core stay
**simple enough to hold in your head**? If not, cut it. Keep deterministic decisions in the
pure, tested `src/sim` core; keep `src/render` a thin projector of what the pure layer computed.
