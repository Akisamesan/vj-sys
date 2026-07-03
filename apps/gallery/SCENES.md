# シーン制作ガイド

100シーンVJコレクションにシーンを追加する実装者(人間・エージェント問わず)向けの規約。
これを読めば registry や engine の再調査なしで1シーンを完結できる。

## 追加手順(配線不要)

1. `src/scenes/<name>.ts` を作る。`<name>` は registry のエントリ title を
   `toLowerCase()` して `_` を除いたもの(例: `TYPO_FIELD` → `typofield.ts`)。
2. `export function create<Name>(ctx: SceneContext): Scene` を1つだけ export する
   (`create` で始まる export 関数が自動配線される。ヘルパーは export しない)。
3. **registry.ts は触らない。** `import.meta.glob` がファイル名規約で自動配線する。
   Planned タプルのままでも即再生可能になる。blurb を充実させたい場合のみ
   タプルを rich エントリに昇格させる(`intensity: 1|2|3` も付けると Live の
   Director が選曲に使う。1=静穏 2=グルーヴ 3=ピーク)。
4. QAを回して通す(下記)。

## Scene 契約(engine/scene.ts)

```ts
interface Scene {
  resize(w, h): void; // マウント時+リサイズ時
  frame(t, dt, audio: AudioEngine): void; // 毎フレーム描画
  key?(k): boolean; // 任意: キー操作
  dispose?(): void; // 通常不要(GLScopeが回収する)
}
```

**絶対規則: 最終描画パスでは `gl.bindFramebuffer(gl.FRAMEBUFFER, null)` を使わない。**
代わりに `ctx.bindOutput()` を呼ぶ(bind+viewport を行う)。Live モードはこれで
シーンをオフスクリーンチャンネルへ回してミックスする。PostFX を使う場合は
`new PostFX(gl, tri, ctx.bindOutput)` と第3引数に渡す。中間パス(自前FBO)は自由。
違反は QA の `nullBind` カウンタが検出する。

## 実装3パターン(参照実装)

| パターン            | 参照                                  | 用途                                      |
| ------------------- | ------------------------------------- | ----------------------------------------- |
| fragment 1パス      | `caustics.ts`(73行)                   | 数式・ノイズ・SDFのフルスクリーンシェーダ |
| プリミティブ+PostFX | `platonic.ts`(GL_LINES+bloom)         | 線・点の幾何をHDR bloomで発光させる       |
| ping-pong GPGPU     | `slime.ts`, `reaction.ts`, `fluid.ts` | 状態を持つシミュレーション                |

共通ヘルパー: `engine/gl.ts`(program/uniforms/texture/framebuffer/FULLSCREEN_VS)、
`engine/glsl.ts`(COMMON_GLSL: hash/snoise/curlNoise/palette)、`engine/postfx.ts`。

## 音シグナルカタログ(AudioEngine)と用法

| シグナル                        | 型                 | 使い方の定石                                       |
| ------------------------------- | ------------------ | -------------------------------------------------- |
| `bass/mid/high/level`           | 平滑 0..1          | 連続量(ズーム・密度・速度)。生値を直接色に使わない |
| `kick/snare/hat`                | そのフレームのみ 1 | 状態変化のトリガ(シード注入・反転・切替)           |
| `kickPulse/snarePulse/hatPulse` | 1→0 減衰           | 発光・衝撃波・パンチなど視覚エンベロープ           |
| `spectrum[24]`                  | log配置 平滑       | 空間に埋め込む(角度=帯域、高さ=強度)               |
| `wave[512]`                     | -1..1              | オシロスコープ・波形描画                           |
| `centroid`                      | 明るさ重心 0..1    | 色相・温度感のゆっくりした変調                     |
| `novelty/change`                | 楽曲変化           | レジーム切替(配色・モード変更)                     |
| `bpm/beatPhase/barPhase`        | テンポ位相         | ビート同期アニメーション(カメラ・脈動)             |
| `beatEnvelope`                  | 1→0 各拍           | キック未検出でも使える拍エンベロープ               |

マッピングの質が シーンの質。最低3系統(連続量1・トリガ1・位相or重心1)を
異なる視覚パラメータに割り当てること。

## 品質基準(QAが機械判定する)

- **BLACK/WHITE**: 無音でも真っ黒にしない(ベース模様を残す)。白飛び面積85%未満
- **STATIC**: 音が鳴っている間、静止画にならない(自律運動+音反応)
- **KICK_WEAK**: kick の瞬間に静止時ノイズと明確に区別できる視覚変化を出す
- **SLOW**: 640×360 で 33ms/frame 以内(fragmentなら余裕。raymarchはステップ数注意)
- **nullBind = 0**: `ctx.bindOutput()` 契約の遵守
- resize 後も破綻しない(FBOの再確保は `resize()` 内で)

制約: TS は erasableSyntaxOnly(parameter property / enum / namespace 禁止)。
`Math.random()` は使用可(QAがシード固定する)。`performance.now()`/`Date.now()` は
シーン内で使わず、`frame(t, dt)` の引数を使う。

## QA の回し方

```sh
vp run gallery#dev                          # devサーバ(例: :5199)
node qa/run.mjs http://localhost:5199/ <id> # 1シーン(例: 96-typo_field)
node qa/run.mjs http://localhost:5199/ all  # 全シーン(~20秒)
open qa-out/sheet.html                      # コンタクトシート目視
node qa/compare.mjs qa-out/baseline.json qa-out/report.json  # 回帰比較
```

ブラウザで `?qa=<id>` を開けば同じ計測をインタラクティブに確認できる。
Live のスモークは `?live&auto=qa&seed=42&shots=6,14,30` → `qa-out/live-*.jpg` と
遷移ログ `live-report.json`(カットに加え blend-hold の `hold:*` イベントも記録。
`auto=qa` は適格セグメントで hold を強制し FPS ガードを無効化するので決定論)。

QA 実行後は Director 用プロファイル(blend-hold のペア選定に使う cost/luma)を
再生成してコミットする:

```sh
node qa/profile.mjs   # qa-out/report.json → src/scenes/profile.gen.ts
```

## スペック様式(ディレクター→実装者)

発注スペックは以下だけで足りる(契約・QA・制約はこのファイルが担う):

```
シーン: <no> <TITLE>(family)
コンセプト: 1〜3文。何が「見どころ」か
技法: パターン(fragment / lines+PostFX / GPGPU)と核になる数理
音→映像マッピング表: シグナル → パラメータ → 視覚効果(3行以上)
パレット: 基調色と変調方針(COMMON_GLSLのpalette推奨)
制約: 負荷上限・パス数など特記事項
```
