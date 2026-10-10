import type { ReactNode } from 'react'
import type { TourStep } from '../components/ui/product-tour'

export type TourId = 'welcome' | 'inbox' | 'proof' | 'new' | 'jobs' | 'job' | 'ledger' | 'rules' | 'receipt' | 'system' | 'deals' | 'clerk' | 'control-room'

const p = (children: ReactNode) => <p>{children}</p>

export const TOUR_LABEL: Record<TourId, string> = {
  welcome: 'the console',
  inbox: 'Today',
  proof: 'Proof',
  new: 'New request',
  jobs: 'Jobs',
  job: 'this job',
  ledger: 'the Ledger',
  rules: 'the Rules',
  receipt: 'a receipt',
  system: 'System',
  deals: 'Deals',
  clerk: 'Ask Mandate',
  'control-room': 'the Control room',
}

/** Which tour belongs to the screen the person is on. */
export function tourFor(pathname: string): TourId {
  if (pathname.startsWith('/p/')) return 'receipt'
  if (pathname.startsWith('/jobs/')) return 'job'
  if (pathname.startsWith('/jobs')) return 'jobs'
  if (pathname.startsWith('/new')) return 'new'
  if (pathname.startsWith('/deals')) return 'deals'
  if (pathname.startsWith('/clerk')) return 'clerk'
  if (pathname.startsWith('/ledger')) return 'ledger'
  if (pathname.startsWith('/control-room')) return 'control-room'
  if (pathname.startsWith('/rules')) return 'rules'
  if (pathname.startsWith('/system')) return 'system'
  if (pathname.startsWith('/proof')) return 'proof'
  return 'inbox'
}

const FLOW: TourStep = {
  title: 'How one payment moves',
  placement: 'center',
  content: (
    <>
      <ol className="tour-list">
        <li><b>Ask.</b> A person or an AI agent asks to move money. Nobody who asks can pay.</li>
        <li><b>Check.</b> The rules answer in code: refused, automatic, or needs you.</li>
        <li><b>Tap.</b> You approve. The exact payee, amount and proof are locked into one hash.</li>
        <li><b>Pay.</b> Only then does the server ask PayPal to move exactly that amount.</li>
        <li><b>Receipt.</b> Every dollar, and every refusal, keeps a record you can open later.</li>
      </ol>
    </>
  ),
}

export const TOURS: Record<TourId, TourStep[]> = {
  welcome: [
    {
      title: 'Welcome to Mandate',
      placement: 'center',
      content: (
        <>
          {p('This is where you decide what your company’s money can do. People and AI agents can ask to spend. They never hold the PayPal key.')}
          {p('The rules decide, you tap, and PayPal moves exactly the amount that was locked. This one-minute tour shows where everything is.')}
          <p className="tour-hint">Use the arrow keys, or press Esc to leave. You can reopen a guide any time with the Guide button.</p>
        </>
      ),
    },
    FLOW,
    {
      target: '[data-tour="nav-waiting"]',
      title: 'Today',
      placement: 'right',
      mobilePlacement: 'top',
      content: (
        <>
          {p('Where you land. What is waiting for you, what is in flight, what was done for you and how, and the month in money.')}
          {p('A request lands under Waiting for you when it is at or above your automatic line, or when the rules say you must decide. Approve locks it. Reject throws it away.')}
        </>
      ),
    },
    {
      target: '[data-tour="nav-jobs"]',
      title: 'Jobs',
      placement: 'right',
      mobilePlacement: 'top',
      content: (
        <>
          {p('A job ties the money in to the money out. The client pays first. Only then can a contractor be paid, up to the share in your rules.')}
          {p('Every job shows a track: Agreed, Delivered, Billed, Client paid, Contractor paid. It says where the job is and the one thing to do next. Start a job, or bill a client, from the buttons at the top.')}
        </>
      ),
    },
    {
      target: '[data-tour="nav-rules"]',
      title: 'Rules',
      placement: 'right',
      mobilePlacement: 'top',
      content: p('Your limits in plain words: who can be paid, which kinds of work are allowed, the automatic line, the monthly cap and the client-money rule. Paste your policy, or say a change in a sentence, and a model drafts it for you to read before you sign. Changing them makes a new version.'),
    },
    {
      target: '[data-tour="nav-activity"]',
      title: 'Activity',
      placement: 'right',
      mobilePlacement: 'top',
      content: (
        <>
          {p('What happened, in three views. The Ledger lists every request ever made, including the refused ones. Proof re-verifies every lock and every amount. The Control room is a dashboard on the same data.')}
          {p('Ask Mandate (Cmd or Ctrl + K) answers “why did we pay this?” from the ledger, from anywhere.')}
        </>
      ),
    },
    {
      target: '[data-tour="keys"]',
      title: 'Your key',
      placement: 'right',
      content: (
        <>
          {p('The owner key can approve, send money and change the rules. A proposer key, the kind an agent gets, can only ask and read.')}
          {p('Lock signs you out of this browser.')}
        </>
      ),
    },
    {
      target: '[data-tour="guide"]',
      title: 'Guide: help on every screen',
      placement: 'bottom',
      mobilePlacement: 'bottom',
      content: (
        <>
          {p('Stuck on any screen? Press Guide for a walkthrough of exactly what you are looking at. A lime dot means you have not seen that screen’s guide yet.')}
          {p('That is the tour. Try New request next: ask for a lunch and see the rules say no.')}
        </>
      ),
    },
  ],

  inbox: [
    {
      target: '[data-tour="page-head"]',
      title: 'Today',
      placement: 'bottom',
      content: p('One page for what matters now. The lime number counts what needs you. Nothing on it has moved money unless it says Done.'),
    },
    {
      target: '[data-tour="today-month"]',
      title: 'The month in money',
      placement: 'bottom',
      content: p('What came in, went out and was kept this month, taken from what PayPal confirmed. The bar is the monthly contractor cap, and the line below says how much ran without a tap and whether autopilot is on.'),
    },
    {
      target: '[data-tour="today-ask"]',
      title: 'Ask Mandate',
      placement: 'bottom',
      content: p('Say what you want in a sentence, from any screen (Cmd or Ctrl + K). The clerk turns it into a request and the rules answer. It can ask, never pay.'),
    },
    {
      target: '[data-tour="today-setup"]',
      title: 'Get set up',
      placement: 'bottom',
      content: p('Eight steps from a fresh install to a job that runs itself. Each links to where you do it. This disappears when they are all done.'),
    },
    {
      target: '[data-tour="today-waiting"]',
      title: 'Waiting for you',
      placement: 'bottom',
      content: p('Only what needs a decision or a nudge: an approval, a payout to send, one on hold, an unclaimed payout, an overdue invoice, something autopilot could not do, or a client dispute. Buttons sit right on each row.'),
    },
    {
      target: '[data-tour="empty"]',
      title: 'Nothing to decide right now',
      placement: 'bottom',
      content: p('When the rules and autopilot have it covered, this is what you see. Smaller requests go through on their own, and anything not on the rules is refused.'),
    },
    {
      target: '[data-tour="approval"]',
      title: 'A request waiting for you',
      placement: 'auto',
      content: p('Who would be paid or billed, how much, what for, and the proof link. For a payout it also shows the client payment that funds it, with a tick when that payment has really settled.'),
    },
    {
      target: '[data-tour="approval-why"]',
      title: 'Why it needs you',
      placement: 'auto',
      content: p('The rule that stopped this from going through on its own, in plain words. For example: the amount is at or above your automatic line.'),
    },
    {
      target: '[data-tour="approve"]',
      title: 'Approve locks it',
      placement: 'top',
      content: (
        <>
          {p('Approve does not send money. It locks the payee, the amount, the proof, the job and the funding into one hash. After that the server can only ever ask PayPal for exactly this.')}
          {p('Reject throws the request away. You can change your mind about a locked payout until it is sent.')}
        </>
      ),
    },
    {
      target: '[data-tour="today-bill"]',
      title: 'Ready to bill',
      placement: 'top',
      content: p('The next milestone of each signed deal. When the work is delivered, paste the proof link and press the button. With autopilot on, the invoice goes to the client straight away.'),
    },
    {
      target: '[data-tour="ready"]',
      title: 'In flight',
      placement: 'top',
      content: p('Invoices waiting for a client, payouts PayPal is processing, and things Mandate is sending. The server asks PayPal about these every few seconds while they are open, and a PayPal webhook makes it instant, so they finish on their own and this page updates without a reload. You can also check or nudge from here.'),
    },
    {
      target: '[data-tour="today-done"]',
      title: 'Done for you',
      placement: 'top',
      content: p('What settled in the last week and how it was approved: your tap, a standing rule, a billing rule, autopilot, or the automatic line. Every row opens its receipt.'),
    },
    {
      target: '[data-tour="refused"]',
      title: 'Stopped by the rules',
      placement: 'top',
      content: p('Requests the rules said no to. They are stored, PayPal was never called, and $0 moved. Being under the automatic line never makes a request allowed.'),
    },
  ],

  new: [
    {
      target: '[data-tour="new-kind"]',
      title: 'What is the money doing?',
      placement: 'bottom',
      content: (
        <>
          <ul className="tour-list">
            <li><b>Money in.</b> Bill a client. They pay through PayPal.</li>
            <li><b>Money out.</b> Pay a contractor, only from client money that already settled on the same job.</li>
            <li><b>Refund.</b> Give back part or all of a payment that settled.</li>
          </ul>
        </>
      ),
    },
    {
      target: '[data-tour="new-party"]',
      title: 'Who',
      placement: 'bottom',
      content: p('People and clients come from your rules. Pick “Someone not on the rules” to see the rules refuse a stranger, whatever the amount.'),
    },
    {
      target: '[data-tour="new-funding"]',
      title: 'Which client payment pays for it',
      placement: 'bottom',
      content: p('A contractor can only be paid from client money that has already arrived. The list shows each settled payment and how much it can still fund. Choose “Nothing yet” to watch the rules refuse it.'),
    },
    {
      target: '[data-tour="new-amount"]',
      title: 'Amount',
      placement: 'bottom',
      content: p('In dollars and cents. Underneath you see the exact whole cents the server will use. Money is never rounded.'),
    },
    {
      target: '[data-tour="new-work"]',
      title: 'Kind of work',
      placement: 'bottom',
      content: p('Only the kinds of work in your rules are allowed. “Something else” lets you try one that is not, like lunch, and see the refusal.'),
    },
    {
      target: '[data-tour="new-proof"]',
      title: 'Link to the work',
      placement: 'bottom',
      content: p('The rules need an https link as proof, like a design file or an invoice. It is kept on the receipt so you can check later.'),
    },
    {
      target: '[data-tour="new-prompt"]',
      title: 'How it was asked',
      placement: 'top',
      content: p('Optional. The sentence the person or agent actually said. It is stored next to the decision, so a receipt can show exactly what was asked.'),
    },
    {
      target: '[data-tour="new-submit"]',
      title: 'Ask the rules',
      placement: 'top',
      content: p('This asks. It does not pay. The answer is one of three: Automatic, Needs you, or Refused. Pressing it twice never asks twice.'),
    },
    {
      target: '[data-tour="new-side"]',
      title: 'The answer appears here',
      placement: 'left',
      mobilePlacement: 'top',
      content: p('The server’s decision, in plain words and in its own words, with the rule that decided it. From here you can open the receipt or go and approve.'),
    },
  ],

  jobs: [
    {
      target: '[data-tour="page-head"]',
      title: 'Jobs',
      placement: 'bottom',
      content: p('One job is one piece of client work. Client money coming in is what releases contractor money going out.'),
    },
    {
      target: '[data-tour="empty"]',
      title: 'No jobs yet',
      placement: 'bottom',
      content: p('A job appears once you bill a client for it. Use “Bill a client” at the top right to start one.'),
    },
    {
      target: '[data-tour="job-card"]',
      title: 'A job at a glance',
      placement: 'auto',
      content: p('The client, how many payments came in and went out, and three bars: In, Out and Kept. Open it for the detail.'),
    },
  ],

  job: [
    {
      target: '[data-tour="job-totals"]',
      title: 'Four numbers tell the story',
      placement: 'bottom',
      content: (
        <ul className="tour-list">
          <li><b>Money in.</b> What the client has paid and PayPal has confirmed.</li>
          <li><b>Money out.</b> What contractors have actually been paid.</li>
          <li><b>Approved, not yet paid.</b> Locked payouts that PayPal has not finished yet.</li>
          <li><b>Kept.</b> What the studio keeps: in, minus out, minus approved.</li>
        </ul>
      ),
    },
    {
      target: '[data-tour="job-charge"]',
      title: 'A client payment and what it funds',
      placement: 'auto',
      content: p('Each settled client payment can fund contractors up to the share in your rules. “Can still fund” is what is left after payouts already approved against it.'),
    },
    {
      target: '[data-tour="job-payouts"]',
      title: 'Payouts under it',
      placement: 'top',
      content: p('Every contractor payout funded by this payment, with where it stands: approved, sent, paid, unclaimed, failed or cancelled. Open one for its receipt.'),
    },
    {
      target: '[data-tour="page-head"]',
      title: 'Next milestone',
      placement: 'bottom',
      content: p('Use “Bill the next milestone” to charge the client again on this same job. Once they pay, more contractor money is released.'),
    },
  ],

  ledger: [
    {
      target: '[data-tour="ledger-tabs"]',
      title: 'Two views of the same history',
      placement: 'bottom',
      content: p('Requests has one row per ask. Events is the step-by-step log underneath: created, approved, sent, paid, refused. Nothing is ever edited or deleted.'),
    },
    {
      target: '[data-tour="ledger-filters"]',
      title: 'Filters',
      placement: 'bottom',
      content: p('Jump to what matters: everything that was refused, what is waiting for you, what has settled, money in, or money out.'),
    },
    {
      target: '[data-tour="ledger-search"]',
      title: 'Search',
      placement: 'bottom',
      content: p('Type a name, part of a description, or a word from the rule, like “funds” or “allowed”, and the table narrows as you type.'),
    },
    {
      target: '[data-tour="ledger-grid"]',
      title: 'Every attempt, with the reason',
      placement: 'top',
      content: p('Dark marks are refusals. The last column says which rule decided, in plain words. Click any row to open its receipt. Refused rows were stored and never reached PayPal.'),
    },
    {
      target: '[data-tour="ledger-foot"]',
      title: 'What the rules kept safe',
      placement: 'top',
      content: p('The total that was asked for and refused. PayPal was never called for any of it.'),
    },
  ],

  'control-room': [
    {
      target: '[data-tour="cr-note"]',
      title: 'A second screen on the same ledger',
      placement: 'bottom',
      content: p('The Ledger is the table of requests. This is the dashboard you build from them. AG Studio is handed plain rows copied from the ledger and can only display them: it has no connection to PayPal or to Mandate.'),
    },
    {
      target: '[data-tour="cr-stage"]',
      title: 'Money in and out count only what PayPal confirmed',
      placement: 'top',
      content: p('A request that was asked for but not paid does not move a tile. Switch to Edit to drag widgets, change what a chart shows, or build your own. Save layout keeps it in this browser.'),
    },
    {
      target: '[data-tour="cr-stage"]',
      title: 'Ask the analyst',
      placement: 'top',
      content: p('In Edit mode the chat panel takes a sentence: “show what the rules refused”. It can read the ledger copy and change this dashboard. It has no tool for PayPal and none for asking Mandate to move money.'),
    },
  ],

  rules: [
    {
      target: '[data-tour="page-head"]',
      title: 'The rules are data, not a prompt',
      placement: 'bottom',
      content: p('A plain function reads these rules on every request. No AI can talk it out of them, and the version number tells you which rules are live.'),
    },
    {
      target: '[data-tour="rules-words"]',
      title: 'Your rules in plain words',
      placement: 'right',
      mobilePlacement: 'bottom',
      content: p('Who can be paid, who can be billed, which work is allowed, where automatic ends and your tap begins, the monthly cap, and the rule that contractors are paid only from money a client already paid.'),
    },
    {
      target: '[data-tour="rules-history"]',
      title: 'History',
      placement: 'left',
      mobilePlacement: 'top',
      content: p('Every version, newest first. Click an old one to read it. A new version never rewrites a request that was already asked.'),
    },
    {
      target: '[data-tour="rules-diff"]',
      title: 'What changed',
      placement: 'left',
      mobilePlacement: 'top',
      content: p('Each version shows exactly what differs from the one before, so a limit cannot change quietly.'),
    },
    {
      target: '[data-tour="rules-write"]',
      title: 'Change the rules',
      placement: 'bottom',
      content: p('Owner only. You edit, review every difference, then publish. Publishing creates the next version. Nothing changes until you confirm.'),
    },
  ],

  proof: [
    {
      target: '[data-tour="page-head"]',
      title: 'Proof, on demand',
      placement: 'bottom',
      content: p('The server re-verifies its own ledger from scratch whenever you press Check again. It trusts no field it did not recompute.'),
    },
    {
      target: '[data-tour="proof-verdict"]',
      title: 'The verdict',
      placement: 'bottom',
      content: p('Green means every check below passed over every request. One failure turns it red and names the request.'),
    },
    {
      target: '[data-tour="proof-checks"]',
      title: 'What was checked',
      placement: 'top',
      content: p('Every lock is intact and signed. Every payment had your tap or a rule you signed. Amounts match to the cent. Contractors were paid from money that had arrived. The cap held. No job paid out more than came in. Signed deals were followed.'),
    },
    {
      target: '[data-tour="proof-reach"]',
      title: 'How the toolkit is used',
      placement: 'top',
      content: p('Of PayPal’s agent tools, zero can be called by an agent. The server runs a handful, and refuses the rest.'),
    },
  ],

  receipt: [
    {
      target: '[data-tour="receipt-decision"]',
      title: 'The decision',
      placement: 'auto',
      content: p('What the rules decided and why, in plain words, with the server’s own sentence underneath. This is the part a cofounder or auditor reads first.'),
    },
    {
      target: '[data-tour="receipt-action"]',
      title: 'The next step',
      placement: 'auto',
      content: (
        <>
          {p('For a client charge: the buyer approves in PayPal, then you press settle. For a contractor payout: press send, and PayPal Payouts pays their own account.')}
          {p('It only says paid after PayPal confirms it. “Sent · processing”, “unclaimed” and “failed” are shown as exactly that.')}
        </>
      ),
    },
    {
      target: '[data-tour="receipt-lock"]',
      title: 'The lock',
      placement: 'left',
      mobilePlacement: 'top',
      content: p('One hash over the payee, the cents, the proof, the job and the funding. Approved and Paid sit side by side, and “cents match” means PayPal moved exactly what you approved.'),
    },
    {
      target: '[data-tour="receipt-funding"]',
      title: 'Funded by',
      placement: 'left',
      mobilePlacement: 'top',
      content: p('For a payout, the client payment that paid for it. Open it to see the other side of the job.'),
    },
    {
      target: '[data-tour="receipt-paypal"]',
      title: 'PayPal’s own ids',
      placement: 'left',
      mobilePlacement: 'top',
      content: p('Order, capture or payout batch and transaction ids, so anyone can find this payment in PayPal.'),
    },
    {
      target: '[data-tour="receipt-asked"]',
      title: 'What was asked',
      placement: 'top',
      content: p('The sentence the person or agent said, the payee, the kind of work and the proof link.'),
    },
    {
      target: '[data-tour="receipt-timeline"]',
      title: 'Timeline, and the receipt file',
      placement: 'left',
      mobilePlacement: 'top',
      content: p('Each step in order, with the time. “Download receipt” saves the whole record as a file for your books.'),
    },
  ],

  deals: [
    {
      target: '[data-tour="page-head"]',
      title: 'Deals come before money',
      placement: 'bottom',
      content: p('The client’s agent and the studio’s agent agree a price and milestones here. The terms must fit both companies’ rules. Agents can say anything to each other; the rules decide what stands.'),
    },
    {
      target: '[data-tour="deal-negotiate"]',
      title: 'Let the agents negotiate',
      placement: 'bottom',
      content: p('Two AI agents, one per company, trade offers, and you watch it happen. Each is told only its own limits. A refusal tells an agent which way to move, never the other side’s number. You can press Stop at any time.'),
    },
    {
      target: '[data-tour="deal-story"]',
      title: 'The live stage',
      placement: 'auto',
      content: p('Each agent takes a seat and shows when it is thinking. Every offer lands as a pin on the price line, studio above and client below, next to the green zone where a deal can exist. A refusal names the rule and which way to move. The agents chose the offers; the rules decided every verdict.'),
    },
    {
      target: '[data-tour="deal-band"]',
      title: 'Where a deal can exist',
      placement: 'auto',
      content: p('The client’s most and the studio’s least, drawn on one line. The green overlap is the only place a deal can be agreed. Only you see this picture; the agents never see each other’s limit.'),
    },
    {
      target: '[data-tour="deal-agreed"]',
      title: 'An agreed deal',
      placement: 'auto',
      content: p('Signed by the server. Its job now accepts charges only for its own milestones, for exactly the agreed amounts.'),
    },
    {
      target: '[data-tour="deal-milestones"]',
      title: 'Bill one milestone at a time',
      placement: 'auto',
      content: p('Add a link to the delivered work and bill the next milestone. That creates a client charge for exactly that amount, which you still approve on the Waiting page.'),
    },
    {
      target: '[data-tour="deal-offer"]',
      title: 'Try it yourself',
      placement: 'top',
      content: p('Offer $450 (over the client’s limit), then $200 (under the studio’s minimum), then $300. The reasons are shown, with a hint of which way to move.'),
    },
    {
      target: '[data-tour="empty"]',
      title: 'No deals yet',
      placement: 'bottom',
      content: p('Press “Let the agents negotiate” to watch a deal form, or make an offer below.'),
    },
  ],

  clerk: [
    {
      target: '[data-tour="clerk-chat"]',
      title: 'Say it in a sentence',
      placement: 'right',
      mobilePlacement: 'bottom',
      content: p('Write what you want in plain words, like you would to a colleague. The clerk looks up the job and the client payment, then asks the rules.'),
    },
    {
      target: '[data-tour="clerk-log"]',
      title: 'Try the fake vendor email',
      placement: 'auto',
      content: p('The third example is a fake vendor email that says to ignore the rules and pay a stranger. The clerk may be fooled into asking. The rules still say no, and $0 moves.'),
    },
    {
      target: '[data-tour="clerk-side"]',
      title: 'What it can and cannot do',
      placement: 'left',
      mobilePlacement: 'top',
      content: p('It can read and ask. It cannot approve, pay or change rules. Anything it asks for that needs your tap shows up on the Waiting page.'),
    },
  ],

  system: [
    {
      target: '[data-tour="system-checks"]',
      title: 'Is the server healthy?',
      placement: 'right',
      mobilePlacement: 'bottom',
      content: p('Live checks: the server is up, the ledger database is ready, and PayPal credentials are set. If a money action fails, look here first.'),
    },
    {
      target: '[data-tour="system-console"]',
      title: 'This console',
      placement: 'left',
      mobilePlacement: 'top',
      content: p('Which key you hold, the server version and whether you are online. Offline, you can still read what was loaded, but nothing that moves money can be sent.'),
    },
  ],
}
