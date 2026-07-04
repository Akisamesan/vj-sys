// The catalogue of 100 VJ scenes, each with a distinct strength. A scene becomes
// playable the moment `src/scenes/<title-lowercase-no-underscores>.ts` exists and
// exports a `create*` factory — the glob below wires it up, so adding a scene never
// touches an import list. Rich entries carry the blurb/keys; Planned tuples are the
// roadmap shown greyed in the index. Scene 01 (LUMEN) ships as its own app (`href`).

import type { SceneDef } from "../engine/scene.ts";

// Every scene module, resolved by filename convention from the entry title.
const MODULES = import.meta.glob<Record<string, unknown>>(["./*.ts", "!./registry.ts"], {
  eager: true,
});

function createOf(title: string): SceneDef["create"] | undefined {
  const m = MODULES[`./${title.toLowerCase().replace(/_/g, "")}.ts`];
  if (!m) return undefined;
  for (const [k, v] of Object.entries(m))
    if (k.startsWith("create") && typeof v === "function") return v as SceneDef["create"];
  return undefined;
}

interface Entry {
  no: string;
  title: string;
  family: string;
  blurb: string;
  href?: string;
  keys?: string;
  intensity?: 1 | 2 | 3;
}

type Planned = [string, string, string, string];

const E: (Entry | Planned)[] = [
  // ---- implemented ----
  {
    no: "01",
    title: "LUMEN",
    family: "particles",
    blurb:
      "周波数帯ごとに積層した約40万パーティクルの3D星雲。スペクトルが立体構造として読み取れる。",
    href: "./lumen/",
  },
  {
    no: "02",
    title: "REACTION",
    intensity: 1,
    family: "reaction-diffusion",
    blurb:
      "Gray-Scott反応拡散。生命的なチューリングパターンが生成・崩壊する。低域と重心がfeed/killを横断し、キックが種を注入、noveltyで配色が変わる。",
    keys: "[R] reseed",
  },
  {
    no: "03",
    title: "MOIRE",
    intensity: 2,
    family: "fragment",
    blurb:
      "万華鏡状の極座標フィールド。鏡像セグメント・干渉リング・トルーシェの織りが、帯域で分割数と回転、低域でズーム、キックで反転と発光する。",
  },
  {
    no: "04",
    title: "TUNNEL",
    intensity: 3,
    family: "raymarch",
    blurb:
      "無限に続くネオントンネルの疾走。低域が飛行速度、キックが手前へ走る光のリングを射出、重心がネオンの色相を動かす。",
  },
  {
    no: "05",
    title: "WARP",
    intensity: 3,
    family: "particles",
    blurb:
      "ハイパースペースのスターフィールド。キックごとにワープし、星が放射状のストリークに伸びる。低域が巡航速度、重心が色を染める。",
  },

  // ---- roadmap (planned) ----
  {
    no: "06",
    title: "FLUID",
    intensity: 2,
    family: "fluids",
    blurb:
      "本物の安定流体ソルバ(移流＋ヤコビ圧力射影)が色染料を押し流す。底のエミッタが煙を吹き上げ、帯域が渦を巻き、キックごとに明るい渦が炸裂する。",
  },
  {
    no: "07",
    title: "BOIDS",
    intensity: 2,
    family: "particles",
    blurb:
      "3Dのマーマレーション。Reynoldsの群れ(分離・整列・結合)が低域で速まり、高域で旋回が締まり、キックで散り、重心が色づく。周回カメラが奥行きを見せる。",
  },
  {
    no: "08",
    title: "NBODY",
    intensity: 2,
    family: "particles",
    blurb:
      "320点の質点が相互重力(ソフト化1/r²)で引き合う多体銀河。渦を巻きながら収縮・拡散する軌道が音で脈動する。低域が重力定数、levelが速度上限とカメラdolly、重心がパレット位相、キックが局所クラスタを外へ散らし重力で再収束させる。",
  },
  {
    no: "09",
    title: "RIBBONS",
    intensity: 2,
    family: "particles",
    blurb:
      "擬似カール流れ場を漂う十数本の発光リボン。各リボンが帯域に対応する太さ・発光を持ち、levelが流速、高域が乱流、キックが一部のリボンを新しい起点へ再スポーンさせる。",
  },
  {
    no: "10",
    title: "VERLET",
    intensity: 2,
    family: "physics",
    blurb:
      "重力・風下で揺れる10本の吊りロープ。Verlet積分+拘束緩和で張力波が末端まで走る。levelが重力・揺れ、低域が風力、キックが根本にインパルスを与え伝播する張力波を可視化し、高域が発光の鋭さを上げる。",
  },
  {
    no: "11",
    title: "SPH",
    intensity: 1,
    family: "fluids",
    blurb:
      "表面張力で結合・分裂する液体金属の水滴群。近距離斥力+凝集力で積分した粒子群を2Dメタボール場として描画。低域が凝集力、キックで分裂→再結合、levelが粘性の低さ、重心が金属パレットに淡い色を差す。",
  },
  {
    no: "12",
    title: "MAGNET",
    intensity: 1,
    family: "physics",
    blurb:
      "双極子磁場に沿って並ぶ砂鉄。低域が磁力線の密度と整列の鋭さ、levelが磁石群の緩やかな移動・回転、キックが極性反転や配置切替、高域が整列のノイズを抑えピシッと揃える。",
  },
  {
    no: "13",
    title: "LIFE",
    intensity: 1,
    family: "cellular",
    blurb:
      "Lenia風の連続ライフゲーム。多数の初期コロニーのうち生き残ったものが有機的な模様へ融合する。キックで新しいコロニーを注入、低域が生存密度の目標を、levelが更新速度を、重心が生セルの色相を変える。",
  },
  {
    no: "14",
    title: "BZ",
    intensity: 2,
    family: "reaction-diffusion",
    blurb:
      "FitzHugh-Nagumo型の興奮性媒質によるBelousov-Zhabotinsky反応。螺旋波が自己組織的に脈打つ。低域が興奮性(波の速さ)、高域が回復性(巻きの細かさ)、キックが新しい波源を注入、重心が3相の配色を回す。",
  },
  {
    no: "15",
    title: "CYCLIC",
    intensity: 2,
    family: "cellular",
    blurb:
      "巡回セルオートマトン。粗い初期ブロックからCAが融解・再編してモザイク状の色面が絶えず変形する。levelが世代速度、低域が遷移しきい値、キックが局所パッチを進めて新しい波源を作り、重心がパレット位相を回す。",
  },
  {
    no: "16",
    title: "SLIME",
    intensity: 1,
    family: "particles",
    blurb:
      "粘菌(Physarum)シミュレーション。約10万のエージェントがフェロモン跡を嗅ぎ取り堆積させ、拡散・減衰しながら生きた輸送ネットワークへ自己組織化する。低域が速度と堆積、高域がセンサー角、キックで散乱する。",
    keys: "[R] reseed",
  },
  {
    no: "17",
    title: "WAVES",
    intensity: 1,
    family: "simulation",
    blurb:
      "離散波動方程式の水面。常時のドリップに加え、キックが波源インパルスを落として波紋が伝播・干渉する。低域が伝播速度と減衰、levelが表示専用のうねり、高域が鏡面ハイライトを鋭くする。",
  },
  {
    no: "18",
    title: "SAND",
    intensity: 1,
    family: "cellular",
    blurb:
      "1次元ハイトフィールド近似の砂丘。帯域ウォーカーが3分割した領域へ砂を積み、キックが安息角を一時的に下げてなだれを起こす。levelがなだれ速度、重心が暖色パレットを染める。",
  },
  ["19", "DLA", "simulation", "拡散律速凝集。雷状・珊瑚状の結晶が音で成長する。"],
  {
    no: "20",
    title: "MANDELBULB",
    intensity: 3,
    family: "raymarch",
    blurb:
      "古典3DフラクタルのマンデルバルブをDEレイマーチ。べき指数が低域で呼吸して開閉し、カメラが周回、重心が虹色の陰影、キックが表面を閃かせる。",
  },
  {
    no: "21",
    title: "MENGER",
    intensity: 3,
    family: "raymarch",
    blurb:
      "折り畳み距離推定でレイマーチするメンガーのスポンジ。周回カメラで回転し、levelが公転と自転を速め、低域がカメラを引き寄せ折り目を脈動させ、重心が配色、高域が鏡面、キックが表面を閃かせる。",
  },
  {
    no: "22",
    title: "TERRAIN",
    intensity: 2,
    family: "raymarch",
    blurb:
      "稜線地形を低空飛行するレイマーチ。低域が山を隆起させ、スペクトルが起伏を波打たせ、重心が空と陽の配色を、キックが稜線の発光を脈打たせる。",
  },
  {
    no: "23",
    title: "METABALLS",
    intensity: 2,
    family: "raymarch",
    blurb:
      "smooth-minで融合する6つの有機的メタボールをレイマーチ。低域が融合の粘りを深め、キックで球が外へ散り、帯域が各球の半径を脈打たせ、重心が虹色の配色、高域がフレネルと鏡面を鋭くする。",
  },
  {
    no: "24",
    title: "GYROID",
    intensity: 2,
    family: "raymarch",
    blurb:
      "終わりなきジャイロイド(TPMS)格子をカメラが前進飛行する。低域がセル密度を詰めて脈動させ、levelが飛行速度、高域が壁を薄く鋭くし、重心が玉虫色のパレットを染め、キックが面を閃かせる。",
  },
  {
    no: "25",
    title: "CLOUDS",
    intensity: 1,
    family: "raymarch",
    blurb:
      "高度のボリュメトリック雲。レイマーチした濃度場を太陽が照らし、低域が雲量を厚くし、重心が空と陽を染め、キックが雲の中で稲妻を閃かせる。",
  },
  ["26", "OCEAN", "raymarch", "Gerstner波の海。うねりが低域で高まる。"],
  ["27", "CITY", "raymarch", "手続き型スカイラインのドライブ。ネオンが拍で点滅。"],
  ["28", "KIFS", "raymarch", "万華鏡IFSフラクタル。折り畳みが音で変形。"],
  {
    no: "29",
    title: "APOLLONIAN",
    intensity: 3,
    family: "raymarch",
    blurb:
      "アポロニウスの球充填フラクタルをレイマーチ(IQ)。空間に無限入れ子の球が詰まり、重心が折り畳みスケールを変えて充填密度を作り替え、低域が構造を手前へ脈動させ、levelが周回、キックが表面を閃かせる。",
  },
  {
    no: "30",
    title: "MANDELBROT",
    intensity: 2,
    family: "fragment",
    blurb:
      "生きたジュリア集合。定数cが音に沿って動き、塵→渦巻き→樹状へと絶えずモーフ。levelが呼吸するズーム、重心が配色、高域が細部を増やす。連続反復彩色。",
  },
  {
    no: "31",
    title: "PLASMA",
    intensity: 2,
    family: "fragment",
    blurb:
      "古典デモシーンのプラズマをスペクトル場として再構築。正弦波の重畳にsnoiseのドメインワープを混ぜた有機的な流れを鮮烈なパレットで彩る。levelが速度、低域がコントラスト、帯域が空間周波数を変調し、重心が色相、高域が微細な波紋、キックが中心から発光する。",
  },
  {
    no: "32",
    title: "VORONOI",
    intensity: 2,
    family: "fragment",
    blurb:
      "セルラー・ボロノイの破砕。各セルが色付きの硝子片になり、音圧で漂い、高域で輪郭が鋭くなり、キックで全体が割れて色相が回る。",
  },
  {
    no: "33",
    title: "TRUCHET",
    intensity: 2,
    family: "fragment",
    blurb:
      "流れるトルーシェの織り。各セルが四分円弧をランダムに置き、線が編み合って無限の迷路状ループになる。帯域が線幅と発光、場が回転・スクロールし、キックでセルの帯が反転する。",
  },
  {
    no: "34",
    title: "HEXGRID",
    intensity: 2,
    family: "fragment",
    blurb:
      "脈動する六角セルのグリッド。各セルが周波数帯のエネルギーで点灯し(中心=低域、外周=高域)、低域でグリッドが呼吸し、キックごとに明るいリングがセルを走り抜け、高域が縁を細く鋭くし、重心が配色を染める。",
  },
  {
    no: "35",
    title: "DOMAINWARP",
    intensity: 2,
    family: "fragment",
    blurb:
      "Inigo-Quilez流のfBmドメインワープ。2段の歪みが場を自身へ折り込み、二度と繰り返さない液状マーブル/星雲を生む。levelが流れ、低域が乱流の深さ、変化が場の原点を漂わせ、重心が色相、高域がフィラメントを鋭くし、キックが発光する。",
  },
  {
    no: "36",
    title: "CAUSTICS",
    intensity: 1,
    family: "fragment",
    blurb:
      "プール底で踊る光。層状の動的セルノイズが明るいコースティクスの網を編み、levelが流れを速め、低域が水の色を深め、高域がフィラメントを鋭くし、キックで波紋が走る。",
  },
  {
    no: "37",
    title: "INTERFERENCE",
    intensity: 1,
    family: "fragment",
    blurb:
      "リップルタンク。6つの円形波源が同心円を放ち、その重ね合わせが動くモアレ干渉縞を描く。低域がリング密度、levelが伝播速度、帯域が各波源の振幅を脈打たせ、キックで波源が揺らぎ新たなリングが広がり、高域が縞を鋭くし、重心が配色を染める。",
  },
  ["38", "PHYLLOTAXIS", "fragment", "葉序の螺旋ドット。重心で開度が変わる。"],
  {
    no: "39",
    title: "GABOR",
    intensity: 2,
    family: "fragment",
    blurb:
      "ノイズが方位を操る配向ストライプ場。局所的に平行な帯が刷毛目/木目のように空間で渦巻く。低域が縞の密度、midが場全体の回転、levelがスクロール、高域が直交スパークルと稜線の鋭さ、重心が色相、キックが発光する。",
  },
  {
    no: "40",
    title: "BARS",
    intensity: 3,
    family: "geometry",
    blurb:
      "3Dスペクトラム・バーの都市。各周波数帯がリング上の光る柱になり、高さがその帯域のエネルギー。カメラが旋回し、床に反射する発光イコライザー。",
  },
  ["41", "TORUS", "geometry", "結ばれたチューブ(トーラス結び)。音で捻れる。"],
  ["42", "LISSAJOUS", "geometry", "3Dリサジュー曲線。周波数比が音で動く。"],
  ["43", "SUPERSHAPE", "geometry", "スーパーフォーミュラのモーフ。"],
  {
    no: "44",
    title: "PLATONIC",
    intensity: 2,
    family: "geometry",
    blurb:
      "回転する正多面体のワイヤーフレーム。ネオンの檻(正四面体→立方体→正八面体→正二十面体)が宙で回り、levelが回転、低域がスケールを脈打たせ、noveltyで次の立体へ切替わる。",
  },
  ["45", "RIBBONTRAIL", "geometry", "音に追従するリボンの軌跡。"],
  ["46", "LATTICE", "geometry", "変形する3D格子。低域で歪む。"],
  ["47", "SPHEREFIELD", "geometry", "インスタンス球の場。帯域で隆起。"],
  ["48", "TENTACLE", "raymarch", "SDFの触手群。音でうねる。"],
  ["49", "ASCII", "typography", "ASCIIスペクトラム。波形が文字に変換される。"],
  {
    no: "50",
    title: "MATRIX",
    intensity: 2,
    family: "typography",
    blurb:
      "落下するグリフの雨。列ごとに輝く先頭と尾を引く軌跡が流れ、低域で雨脚が速まり、重心が色を染め、キックがランダムな列にバーストを走らせる。",
  },
  {
    no: "51",
    title: "GLITCH",
    intensity: 3,
    family: "glitch",
    blurb:
      "データモッシュのフィードバック。前フレームがブロック変位とチャンネルずれで還流し、スペクトラムの帯が色を注入。スネアとキックで画面が裂け、反転・走査線が走る。",
  },
  {
    no: "52",
    title: "OSCILLOSCOPE",
    intensity: 2,
    family: "scan",
    blurb:
      "CRTベクトルスコープ。生の音声波形を発光するリン光のリングに巻きつけ(半径=信号)、音そのものが描く軌跡を見る。低域がリングを膨らませ、levelがビームを輝かせ、重心がリン光を染める。",
  },
  ["53", "SCOPE_XY", "scan", "X-Yリサジュー・スコープ。ステレオ的に揺れる。"],
  ["54", "TYPO", "typography", "キネティック・タイポグラフィ。語が拍で結晶化。"],
  ["55", "SLITSCAN", "glitch", "スリットスキャン。時間が空間に引き伸ばされる。"],
  ["56", "FEEDBACK", "feedback", "ビデオフィードバックの無限再帰。種図形が音で動く。"],
  ["57", "RUTTETRA", "scan", "Rutt-Etra走査線変位。輝度が起伏になる。"],
  ["58", "LASERS", "light", "ビームのグリッド。拍でスイープ。"],
  ["59", "STROBE", "light", "ストロボ・パターン。発火で明滅。"],
  ["60", "BOKEH", "light", "デフォーカスの光球。低域で被写界が呼吸。"],
  ["61", "PRISM", "light", "プリズム分光。白色が虹に割れる。"],
  {
    no: "62",
    title: "AURORA",
    intensity: 1,
    family: "light",
    blurb:
      "星空にかかるオーロラのカーテン。fBmのリボンが波打ち、低域がカーテンを持ち上げ、高域が揺らめかせ、重心が緑↔紫の色相を動かし、キックが光の波を走らせる。",
  },
  ["63", "GODRAYS", "light", "放射状の光芒。重心で射す方向が変わる。"],
  ["64", "NEONSIGN", "light", "明滅するネオン管。拍で点灯シーケンス。"],
  ["65", "KALEIDO_FB", "feedback", "フィードバック万華鏡。再帰像が回転対称に。"],
  ["66", "INK", "fluids", "水中のインク。拍で滴下し拡散。"],
  ["67", "FIRE", "fluids", "炎のシミュレーション。低域で燃え上がる。"],
  ["68", "SMOKE", "fluids", "浮力煙。音源から立ち上る。"],
  ["69", "LIGHTNING", "procedural", "枝分かれする稲妻。キックで放電。"],
  ["70", "CORAL", "simulation", "珊瑚の成長。音でブランチが伸びる。"],
  ["71", "VEINS", "simulation", "葉脈のオークラ-トロイ成長。"],
  ["72", "FUR", "fragment", "梳かれた毛皮の場。音で流れが変わる。"],
  ["73", "BUBBLES", "fragment", "石鹸膜の虹色干渉。厚みが音で揺れる。"],
  ["74", "SHEETS", "geometry", "流れる3Dシート。低域でうねる。"],
  ["75", "FLAG", "physics", "風になびく旗。突風が拍で吹く。"],
  ["76", "PENDULUM", "physics", "カオス二重振り子の群れ。軌跡が描かれる。"],
  ["77", "SPRINGMESH", "physics", "質点ばねメッシュ。発火で波が走る。"],
  {
    no: "78",
    title: "ATTRACTOR",
    intensity: 2,
    family: "strange",
    blurb:
      "ローレンツのストレンジアトラクタを点群で。数千の粒子がカオス流に乗って蝶を描き、低域が翼(ρ)を広げ、levelが視点を回し、重心が雲を染める。",
  },
  ["79", "ROSSLER", "strange", "レスラー・アトラクタの軌道。"],
  ["80", "CLIFFORD", "strange", "クリフォード・アトラクタの点雲。"],
  {
    no: "81",
    title: "FIELDLINES",
    intensity: 1,
    family: "fragment",
    blurb:
      "動くノイズ流れ場の流線。各ピクセルが場に沿って前後に積分するLIC近似で、磁力線のように輝く流線が現れる。低域が渦の大きさと流線長、levelが流速、変化が渦を再編成し、高域が線を鋭くし、重心が色相、キックが発光する。",
  },
  ["82", "WANG", "pattern", "ウォンタイルの非周期パターン。"],
  ["83", "PENROSE", "pattern", "ペンローズ・タイリング。拍で膨張。"],
  ["84", "GIRIH", "pattern", "ギリ(イスラム幾何)パターンの生成。"],
  ["85", "QUILT", "pattern", "生成的なキルト。帯域で配色。"],
  ["86", "STAINED", "pattern", "ステンドグラス状ボロノイ。光が透ける。"],
  ["87", "CIRCUIT", "pattern", "PCBの配線が音で引かれていく。"],
  ["88", "MAZE", "pattern", "成長する迷路。拍で経路が伸びる。"],
  {
    no: "89",
    title: "SPECTROGRAM",
    intensity: 1,
    family: "spectral",
    blurb:
      "スクロールするスペクトログラムの滝。毎フレーム右端に最新の周波数列を書き、履歴が左へ流れる。音の直近の過去がヒートマップとして見える。重心で配色、キックで先頭が輝く。",
  },
  {
    no: "90",
    title: "RADIAL_EQ",
    intensity: 2,
    family: "spectral",
    blurb:
      "放射イコライザーの開花。24帯域が円周に巻きつき上下対称の花弁として咲き、各花弁の長さがその帯域のエネルギー。キックごとに同心リングが中心から広がり、低域でコアが脈動し、重心が配色、高域が花弁の先端を煌めかせる。",
  },
  ["91", "TERRAIN_FFT", "spectral", "スペクトラムが地形になり前進する。"],
  ["92", "PARTICLE_FFT", "spectral", "パーティクルで作るバーグラフ。"],
  {
    no: "93",
    title: "MANDALA",
    intensity: 1,
    family: "spectral",
    blurb:
      "スペクトラムを同心リングの花弁に写す対称マンダラ。N回対称＋鏡映で各半径リングが帯域に対応し、そのエネルギーで花弁が開く。低域でマンダラが呼吸し、変化で対称数が組み替わり、高域がフィリグリーを細かくし、キックで中心の宝石が閃く。",
  },
  {
    no: "94",
    title: "CYMATICS",
    intensity: 2,
    family: "spectral",
    blurb:
      "クラドニの振動板。定在波モード(m,n)が干渉し、板が静止する節線に砂が集まって対称図形を描く。帯域がモード数を駆動して模様が再構成され、キックで板が鳴り、重心が砂を染める。",
  },
  {
    no: "95",
    title: "RINGS",
    intensity: 3,
    family: "spectral",
    blurb:
      "同心ビートリング＋放射イコライザー。スペクトラムが円周に巻きつき(角度=周波数)、ラウドな帯域が外へ膨らみ、キックごとに明るい衝撃波リングが縁まで広がる。",
  },
  ["96", "TYPO_FIELD", "spectral", "エネルギー場CA上に文字が現れる。"],
  ["97", "KNOT", "geometry", "音で変形するトーラス結び目。"],
  ["98", "BLACKHOLE", "raymarch", "重力レンズのブラックホール。降着円盤が脈動。"],
  ["99", "WORMHOLE", "raymarch", "ワームホールを抜ける。"],
  ["100", "SUPERNOVA", "spectral", "フィナーレ。全帯域の超新星爆発。"],
];

export const SCENES: SceneDef[] = E.map((e) => {
  if (Array.isArray(e)) {
    const [no, title, family, blurb] = e;
    return {
      id: `${no}-${title.toLowerCase()}`,
      no,
      title,
      family,
      blurb,
      create: createOf(title),
    };
  }
  return {
    id: `${e.no}-${e.title.toLowerCase()}`,
    no: e.no,
    title: e.title,
    family: e.family,
    blurb: e.blurb,
    create: e.href ? undefined : createOf(e.title),
    href: e.href,
    keys: e.keys,
    intensity: e.intensity,
  };
});

export function findScene(id: string | null): SceneDef | undefined {
  return SCENES.find((s) => s.id === id);
}
