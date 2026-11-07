/**
 * 테스트용 최소 PDF(글을 뽑을 수 있는 것). 한국어도 되도록 Type0(Identity-H) 글꼴 + ToUnicode CMap을 쓴다(글꼴 파일은 넣지 않는다 —
 * 글 뽑기는 ToUnicode만 본다). 줄바꿈마다 한 줄씩 그린다. BMP 밖 글자는 쓰지 않는다.
 */
export function makeTestPdf(text: string): Uint8Array<ArrayBuffer> {
  const chars = [...new Set([...text.replace(/\n/g, "")])];
  const cid = new Map(chars.map((c, i) => [c, i + 1]));
  const hex4 = (n: number) => n.toString(16).padStart(4, "0").toUpperCase();
  const lines = text.split("\n").filter((l) => l.length > 0);
  const content = lines
    .map((line, i) => `BT /F1 10 Tf 40 ${800 - i * 14} Td <${[...line].map((c) => hex4(cid.get(c)!)).join("")}> Tj ET`)
    .join("\n");
  const bf: string[] = [];
  for (let i = 0; i < chars.length; i += 100) {
    const part = chars.slice(i, i + 100);
    bf.push(`${part.length} beginbfchar\n${part.map((c) => `<${hex4(cid.get(c)!)}> <${hex4(c.charCodeAt(0))}>`).join("\n")}\nendbfchar`);
  }
  const cmap = [
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Adobe-Identity-UCS def /CMapType 2 def",
    "1 begincodespacerange <0000> <FFFF> endcodespacerange",
    ...bf,
    "endcmap CMapName currentdict /CMap defineresource pop end end",
  ].join("\n");
  const stream = (body: string) => `<< /Length ${Buffer.byteLength(body, "latin1")} >>\nstream\n${body}\nendstream`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    stream(content),
    "<< /Type /Font /Subtype /Type0 /BaseFont /TestFont /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>",
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /TestFont /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 8 0 R /DW 1000 >>",
    stream(cmap),
    "<< /Type /FontDescriptor /FontName /TestFont /Flags 4 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 900 /Descent -100 /CapHeight 700 /StemV 80 >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}
