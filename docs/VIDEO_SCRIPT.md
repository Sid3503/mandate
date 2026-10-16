# Mandate: Demo Video Script

Target duration: 2 minutes 45 seconds (maximum allowed: 3 minutes 00 seconds).

---

## Storyboard and Timed Shots

| Shot | Time | Screen and Click Path | On-Screen Text | Voice-Over (<= 20 words) |
| --- | --- | --- | --- | --- |
| 1 | 0:00 - 0:15 | Welcome screen at `/app/welcome` showing the problem setup | Agents can ask. Only you can pay. | Meera runs a studio. AI agents draft invoices and propose payments. But giving an AI agent payment authority is dangerous. |
| 2 | 0:15 - 0:30 | Architecture diagram showing AI proposals flowing into deterministic gate | Deterministic spend boundary | Mandate creates a deterministic spending boundary. Any agent can ask to spend, but only pure code decides what moves. |
| 3 | 0:30 - 0:45 | Welcome page click path: click **"Try the demo"** (`/demo/start`) | Ephemeral demo workspace | At Welcome door, Meera clicks Try the demo to launch an isolated ephemeral workspace with zero setup. |
| 4 | 0:45 - 1:00 | Today screen displaying yellow demo banner and role switcher pills | Simulated PayPal · 24h demo | The top banner confirms simulated money and provides instant role switching between owner, proposer, and viewer. |
| 5 | 1:00 - 1:15 | Rules screen (`/app/rules`) showing policy flags and natural language rules | Rules in words: 60% contractor share | In Rules, Meera writes standing rules in plain English: paying Priya sixty percent of settled client invoices. |
| 6 | 1:15 - 1:30 | Today screen clicking a bad proposal: "Team lunch $18.00" | Refused: category.missing | On Today, an unauthorized eighteen dollar lunch request is blocked instantly. The model is ignored; rules say category missing. |
| 7 | 1:30 - 1:45 | Header emergency control: click **"Pause system"** | Emergency pause active | Next, an attacker tries draining funds. Meera presses Emergency Pause, immediately halting all outbound money movement. |
| 8 | 1:45 - 2:00 | Resume system, view Priya's $90 waiting payout backed by Northwind capture | Waiting approval · Priya Shah $90 | A legitimate ninety dollar contractor payout arrives for Priya, backed by Northwind's settled invoice. Meera approves it. |
| 9 | 2:00 - 2:15 | Passkey prompt with biometric touch / Face ID confirmation | WebAuthn passkey step-up | Meera confirms with a biometric passkey tap. WebAuthn signs the locked cart hash with hardware grade security. |
| 10 | 2:15 - 2:30 | Today screen updates to "Paid · no tap" with PayPal payout receipt | PayPal Payouts v1: sent | The ninety dollar payout is sent automatically through PayPal Payouts, keeping sixty dollars in the studio account. |
| 11 | 2:30 - 2:40 | Proof screen (`/app/proof`) clicking **"Verify receipt offline"** | Cryptographic verification: PASS | Under Proof, Meera verifies the cryptographic receipt offline in the browser. Any tampering fails verification immediately. |
| 12 | 2:40 - 2:45 | Closing splash with GitHub link and Devpost summary | Mandate · Agents ask, you pay | Agents can ask. Only you can pay. Mandate gives you complete control over your AI spend. |

---

## Production Notes

- **Total Duration**: 165 seconds (2:45).
- **Resolution**: 1920x1080 (1080p, 60fps).
- **Pacing**: Steady pacing with clear cursor highlights and zero skipped steps.
- **Microphone**: Clean audio narration with pop filter and no background music.
- **Privacy Check**: Zero real API keys, email addresses, or personal file paths appear in browser or console.
