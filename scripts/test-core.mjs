import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildSnapshotValidation,
  parseSectorDetail,
  sortSectorsByTradingValue,
  sortStocksByTradingValue
} from "../server.js";

function assertDescending(items, field, label) {
  for (let index = 1; index < items.length; index += 1) {
    const previous = Number(items[index - 1]?.[field] || 0);
    const current = Number(items[index]?.[field] || 0);
    assert.ok(previous >= current, `${label} is not sorted by ${field}: ${previous} < ${current}`);
  }
}

const sector = {
  id: "101",
  name: "테스트 반도체",
  changeRate: 0,
  stockCount: 4,
  risingCount: 2,
  flatCount: 1,
  fallingCount: 1,
  naverUrl: "https://finance.naver.com/sise/sise_group_detail.naver?type=upjong&no=101"
};

const fixtureHtml = `
<table>
  <thead>
    <tr>
      <th>종목명</th>
      <th>현재가</th>
      <th>전일비</th>
      <th>등락률</th>
      <th>거래량</th>
      <th>거래대금</th>
      <th>시가총액</th>
      <th>시장</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td class="name"><a href="/item/main.naver?code=000001">대장주</a></td>
      <td class="number">10,000</td>
      <td class="number">100</td>
      <td class="number">+1.00%</td>
      <td class="number">1,000,000</td>
      <td class="number">10,000</td>
      <td class="number">100,000</td>
      <td>KOSPI</td>
    </tr>
    <tr>
      <td class="name"><a href="/item/main.naver?code=000002">보정대상주</a></td>
      <td class="number">5,000</td>
      <td class="number">-50</td>
      <td class="number">-1.00%</td>
      <td class="number">1,000,000</td>
      <td class="number">999</td>
      <td class="number">50,000</td>
      <td>KOSDAQ</td>
    </tr>
    <tr>
      <td class="name"><a href="/item/main.naver?code=000003">소형주</a></td>
      <td class="number">2,000</td>
      <td class="number">0</td>
      <td class="number">0.00%</td>
      <td class="number">100,000</td>
      <td class="number">200</td>
      <td class="number">20,000</td>
      <td>KOSPI</td>
    </tr>
    <tr>
      <td class="name"><a href="/item/main.naver?code=069500">KODEX 200</a></td>
      <td class="number">30,000</td>
      <td class="number">0</td>
      <td class="number">0.00%</td>
      <td class="number">9,999,999</td>
      <td class="number">299,999</td>
      <td class="number">1,000,000</td>
      <td>ETF</td>
    </tr>
  </tbody>
</table>`;

const parsedSector = parseSectorDetail(fixtureHtml, sector);

assert.equal(parsedSector.id, "101", "sector id must be preserved");
assert.equal(parsedSector.name, "테스트 반도체", "sector name must be preserved");
assert.equal(parsedSector.stockCount, 3, "ETF/ETN/ELW rows must be excluded from normal stock count");
assert.equal(parsedSector.excludedEtfEtnCount, 1, "ETF exclusion count must be tracked");
assert.equal(parsedSector.unverifiedTradeAmountCount, 0, "trade amount parser must not leave unverified rows in fixture");
assert.equal(parsedSector.validation.status, "ok", "fixture sector should pass validation");
assert.ok(parsedSector.repairedTradeAmountCount >= 1, "invalid trade amount column must be repaired from price × volume");

assert.deepEqual(
  parsedSector.stocks.map((stock) => stock.code),
  ["000001", "000002", "000003"],
  "stocks must be sorted by validated daily trading value"
);
assertDescending(parsedSector.stocks, "tradeAmountMillion", "parsed sector stocks");
assertDescending(sortStocksByTradingValue(parsedSector.stocks), "tradeAmountMillion", "sortStocksByTradingValue");

const badSectorOrder = buildSnapshotValidation([
  { ...parsedSector, id: "low", tradingValueMillion: 10 },
  { ...parsedSector, id: "high", tradingValueMillion: 20 }
]);
assert.equal(badSectorOrder.status, "warning", "snapshot validation must catch sector order inversions");
assert.equal(badSectorOrder.sectorOrderErrorCount, 1, "one sector order inversion should be counted");

const sortedSectors = sortSectorsByTradingValue([
  { id: "low", tradingValueMillion: 10, volume: 1 },
  { id: "high", tradingValueMillion: 20, volume: 1 }
]);
assert.deepEqual(sortedSectors.map((item) => item.id), ["high", "low"], "sectors must sort by trading value desc");

const appSource = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
assert.match(appSource, /String\(data\?\.id\) === requestedId/, "detail fetch must ignore stale sector responses");
assert.match(appSource, /sameSectorDetail\(detail, sector\)/, "UI must only use detail data that matches selected sector");
assert.match(appSource, /setSectorDetail\(\(current\) => \(sameSectorDetail\(current, selectedSector\) \? current : null\)\)/, "UI must clear previous sector detail on selection change");

console.log("Core data integrity tests passed.");
