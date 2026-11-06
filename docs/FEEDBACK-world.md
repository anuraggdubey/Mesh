# World integration debrief (required by both World tracks)

Fill this in as we go. Judges read it. Be specific and honest.

- **Products used:** IDKit (Proof of Human, action `register-provider`) and World Agent Pass (World IdP device grant, human approval above a spending threshold).
- **Why these credentials:** Proof of Human is the minimum sufficient assurance for "one human, one provider profile" (strict uniqueness). Agent approvals need a fresh Orb-level authentication at the moment of the spend.
- **Time to first success:** _(record: start time, first verified proof)_
- **Friction encountered:** _(known so far: "Agent Pass" is not named in the docs we read; the IdP portal requires HTTPS callbacks so localhost cannot be used for the browser flow; no documented mock mode; the IDKit `signal` to `signal_hash` derivation is not documented; no env var names for the OIDC client)_
- **Missing capability or documentation:** _(fill in)_
- **The one improvement with the greatest impact:** _(fill in; candidate: a documented mock mode / test identity with a localhost-friendly callback)_
- **Denied paths demonstrated:** invalid / missing / reused IDKit proof (no provider registered); denied, expired or mismatched approval (no job created).

- **Agent Pass portal access (found live):** `auth.world.org/portal` returned `{"error":"invalid_login"}` after Google sign-in, then "sign in with your enterprise account", then "not eligible" for regular accounts. We could not create the OIDC client, so the device grant was only tested against a local fake issuer. Fallback built: a World ID (IDKit) proof made per approval, on `/approve/<id>`, verified on the server (spec section 17.1). Suggested fix on World's side: say on the docs page that the portal needs an enterprise account, and offer a sandbox client for hackathon teams.
