import { useState } from "react";
import { AllCommunityModule, themeQuartz } from "ag-grid-community";
import { AgGridProvider, AgGridReact } from "ag-grid-react";

const rows = [
  { decision: "DENY", reason: "description is not in the allowed list", status: "", amount: null, orderId: "", captureId: "" },
  { decision: "NEEDS_APPROVAL", reason: "at or above 20", status: "CREATED", amount: 25, orderId: "0NP39845W0132493F", captureId: "" },
  { decision: "NEEDS_APPROVAL", reason: "at or above 20", status: "COMPLETED", amount: 25, orderId: "0NP39845W0132493F", captureId: "9CU63483HP273314T" },
];

const columns = [
  { field: "decision", filter: true, width: 180 },
  { field: "reason", filter: true, flex: 1 },
  { field: "status", filter: true, width: 150 },
  { field: "amount", filter: "agNumberColumnFilter", width: 120 },
  { field: "orderId", width: 220 },
  { field: "captureId", width: 220 },
];

export default function App() {
  const [quick, setQuick] = useState("");
  return (
    <AgGridProvider modules={[AllCommunityModule]}>
      <main style={{ height: "100vh", display: "flex", flexDirection: "column", padding: 16, gap: 12 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Mandate ledger</h1>
        <input
          value={quick}
          onChange={(e) => setQuick(e.target.value)}
          placeholder="Filter, try DENY or 9CU63483"
          style={{ padding: 8, fontSize: 16 }}
        />
        <div style={{ flex: 1 }}>
          <AgGridReact
            theme={themeQuartz}
            rowData={rows}
            columnDefs={columns}
            quickFilterText={quick}
            pagination
            paginationPageSize={20}
          />
        </div>
      </main>
    </AgGridProvider>
  );
}
