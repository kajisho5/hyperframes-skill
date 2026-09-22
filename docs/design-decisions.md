# Design decisions

Behaviour that looks like a bug but is intentional. An entry is added the first time a
reviewer (human or agent) reports something here as a defect and it turns out to be
deliberate: the decision, why, and the test that pins it, so the next review does not report
it again.

Format:

```
## D<n>. <one-line statement of the behaviour>

- **Reported as:** what the reviewer thought was wrong (link the review if there is one)
- **Decision:** what the code does and will keep doing
- **Why:** the reason, including what the alternative would break
- **Pinned by:** the test that fails if it changes
```

No entries yet.
