import { roundDecimal } from './expressionEngine.ts';

export type DataRow = Record<string, string | number | boolean | null>;

export function generateBankingDataset(reportId: string, rowCount = 18): Record<string, DataRow[]> {
  switch (reportId) {
    case 'account-statement': {
      const particularsPool = [
        'NPSB Clearing · Utility Settlement',
        'RTGS Corporate Collection (ঢাকা ইলেকট্রিক)',
        'EFTN Payroll Disbursement · Batch 04',
        'SWIFT Inward Trade Proceeds',
        'POS Merchant Settlement · Motijheel',
        'Cash Deposit · Counter 03 (গুলশান শাখা)',
        'LC Commission & Stamp Duty',
        'Treasury Bond Coupon Credit',
      ];
      const rows: DataRow[] = [];
      let balance = 125000.0;
      for (let i = 0; i < rowCount; i++) {
        const day = String((i % 28) + 1).padStart(2, '0');
        const isCredit = i % 3 === 0 || i === 0;
        const credit = isCredit ? roundDecimal(14500 + ((i * 3750.25) % 45000), 2) : 0;
        const debit = !isCredit ? roundDecimal(2150 + ((i * 1940.5) % 18500), 2) : 0;
        balance = roundDecimal(balance + credit - debit, 2);
        rows.push({
          TranDate: `2026-11-${day}T10:15:00Z`,
          Reference: `TXN-${String(1001 + i).padStart(5, '0')}`,
          Particulars: particularsPool[i % particularsPool.length],
          Debit: debit,
          Credit: credit,
          Balance: balance,
        });
      }
      return { Transactions: rows };
    }

    case 'remittance-advice': {
      const fxAmount = 2450.0;
      const exRate = 119.5;
      const baseBdt = roundDecimal(fxAmount * exRate, 2);
      const incentive = roundDecimal(baseBdt * 0.025, 2);
      return {
        RemittanceLines: [
          {
            Component: 'Principal Foreign Remittance',
            SenderBank: 'Citibank N.A. Singapore',
            FxCurrency: 'USD',
            FxAmount: fxAmount,
            ExRate: exRate,
            BdtAmount: baseBdt,
          },
          {
            Component: 'Govt. Cash Incentive (2.5%)',
            SenderBank: 'Bangladesh Bank Subsidy Pool',
            FxCurrency: 'BDT',
            FxAmount: 0,
            ExRate: 1.0,
            BdtAmount: incentive,
          },
        ],
      };
    }

    case 'npsb-reconciliation': {
      const banks = ['Sonali Bank PLC', 'BRAC Bank PLC', 'Dutch-Bangla Bank', 'City Bank PLC', 'Islami Bank BD'];
      const channels = ['ATM-ACQ', 'POS-EMV', 'IBFT-INSTANT', 'QR-BANGLA'];
      const rows: DataRow[] = [];
      for (let i = 0; i < rowCount; i++) {
        const amount = roundDecimal(1500 + ((i * 2310.75) % 65000), 2);
        const isException = i % 11 === 4;
        rows.push({
          Stan: String(780100 + i),
          Channel: channels[i % channels.length],
          Acquirer: banks[i % banks.length],
          Amount: amount,
          Variance: isException ? 250.0 : 0.0,
          MatchStatus: isException ? 'Exception' : 'Matched',
        });
      }
      return { SettlementRows: rows };
    }

    case 'daily-branch-cash': {
      const sections = ['Retail Counter', 'Corporate Desk', 'SME Treasury', 'Vault Reserve'];
      const rows: DataRow[] = [];
      const count = Math.min(rowCount, 48);
      for (let i = 0; i < count; i++) {
        const cashIn = roundDecimal(45000 + ((i * 12350) % 180000), 2);
        const cashOut = roundDecimal(22000 + ((i * 9840) % 130000), 2);
        rows.push({
          TellerId: `TLR-${String(i + 1).padStart(3, '0')}`,
          Section: sections[i % sections.length],
          CashIn: cashIn,
          CashOut: cashOut,
          NetPosition: roundDecimal(cashIn - cashOut, 2),
        });
      }
      return { CashEntries: rows };
    }

    case 'customer-certificate':
      return {
        Balances: [
          { Facility: 'Current Corporate Account', AccountRef: '1040-883920-001', Currency: 'BDT', ClearedBalance: 1482950.75 },
          { Facility: 'Special Notice Deposit (SND)', AccountRef: '1040-883920-019', Currency: 'BDT', ClearedBalance: 640000.0 },
          { Facility: 'Fixed Deposit Receipt (FDR-12M)', AccountRef: '1040-991042-088', Currency: 'BDT', ClearedBalance: 2500000.0 },
        ],
      };

    default:
      return {};
  }
}
