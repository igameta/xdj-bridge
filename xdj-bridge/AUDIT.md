# 独立監査結果

2026-11-05追記: AZ返却後、保存済み実測と実装の到達点を独立確認し、[現状確定記録](docs/STATUS-20261105.md)へ整理した。存在通知・BPM232.00の本体照合・NFSのDBヘッダ読取を確認したが、曲名解析・再生中曲との対応・本番への統合は未達。以下の初期実装監査でいう「実機参加試験は行っていない」は、その監査時点の範囲を示す。後続の実機調査は現状確定記録を参照。

監査日: 2026-10-31 (Asia/Tokyo、初回2026-10-29)。対象: BACKEND-ADAPTER-DESIGN-20261026.mdに基づくxdj-bridge初期実装。実装担当とは別の監査サブエージェントがコードを確認し、独立した回帰テストを追加した。

**結果: 最終テスト152件すべて成功。監査で検出した要修正事項は修正済み。** 保存済みRX3通信を正規化し、可視化とOSCへ配信する経路に加え、画面からの接続先切替、OSC設定変更、設定メニューと表示の安定性、曲名・artistの拡大、再生枠強調、4デッキの表示と出力、MASTER優先の代表デッキOSCを確認した。最終全体suiteには通知機能・LAN内の受信探索・AZ OFF向け試験モードの独立監査も含む。新規の実機参加試験は行っていない。過去のRX3受信を維持した画面確認と、今回の合成データ検証を区別している。

## 検証した内容

| 対象 | 結果・根拠 |
|---|---|
| RX3状態 | 保存fixtureと実pcapngに一致。wire 11/12→Deck 1/2、BPM122、実効BPM約137.311、標準playing flag=falseでもplayState4をplayingとして解釈。無効beatはnull。 |
| 入力境界 | magic/port/type/subtype/minimum lengthを検証。不正・切詰めパケットで状態を誤更新しない。pcap/pcapng両endian・timestamp resolution・複数sectionも回帰検証。 |
| 識別・世代 | メディア所有者とslotを含むTrackRef、曲切替・メディア交換・再接続での世代更新、旧メタデータ応答の棄却を確認。 |
| 未知値・鮮度 | null/unknownと最後の値のstaleを分離。BPM、拍、位置、メタデータの利用状態が値の無効化に追従する。 |
| セッション | 明示IF、重複サブネットの起動拒否、観測番号を避ける選択、番号競合時の停止、排他的UDP bindと終了時解放をコード確認。参加パケット全12件とkeepaliveを、既存Python実装から固定したfixtureと照合。 |
| passive | native/alphathetaの受動経路に参加通知・NFS・dbserver要求を実装していないことを確認。alphathetaは公開PcapAdapterを使用。単発フレームエラーで全セッションを停止しない。 |
| LAN探索 | 50000を受信する有限探索と既存liveの結果再利用。複数IP・番号・IF根拠・受信途絶を分離し、探索から参加・OSC・OS通知を開始しない。独立13件成功。 |
| AZ OFF試験 | 明示選択のPC型presence候補と停止・取消をfake UDPで検証。独立11件成功。現場FW1.23 / Windowsの4デッキ取得は未検証。 |
| WebSocket | 実接続でsnapshot→baseRevision/revision付きdelta→resyncを確認。Host/Origin拒否、既定静的資産の配信も検証。遅い購読者への最新snapshot集約はコード確認。 |
| OSC | 実UDP受信でvalid/quality/fresh、未知値の値パス省略、1200byte上限、各bundleのrevision、周期snapshotを確認。代表デッキはMASTER優先・再生中fallbackとし、全fragmentに短い代表IDを反復する。切断直後のcloseでも最終valid=0が届く。 |
| Provider | 有限試行、待機キュー上限、世代ごとの成功/失敗分離を検証。timeout後も未終了処理が同時実行枠を保持し、孤児要求を増やさない。 |
| UI | デモ明示、未知値表示、独立にstaleとなった位置・拍位相の表示、空snapshotでの旧カード除去をコード確認。JavaScript構文検査に成功。描画担当もDOM回帰検証を実施。 |
| 配布 | optional依存を省いたクリーンインストール・ビルド・テストに成功。コンパイル済みruntimeを別フォルダへ展開し、production依存だけでHTTP/UI・4デッキ・OSC・終了時無効化を検証。 |

監査者は接続・OSC切替までの全53件を npm run build && node --test dist/tests/*.test.js で実行し、53 pass / 0 fail / 0 skipを確認した。その後、監査者もUI11件と独立4デッキ監査4件を実行し全件成功。4デッキ対応時の親の全suiteは74 pass / 0 fail / 0 skipだった。代表OSC追加後は監査者もcore11件・代表core8件・代表OSC4件・代表独立6件の29件を実行し全件成功し、親エージェントが通知機能を含む最終全suiteを再実行して103 pass / 0 fail / 0 skipを確認した。監査専用tests/audit.test.tsは元の7件と4デッキの4件を合わせ11件で、媒体交換、機能別利用状態、旧メタデータのOSC無効化、重複IF、Provider timeout、終了時UDP通知、4デッキの共有媒体と独立出力を検証する。接続操作機能ではruntime.test.tsの10件と監査専用runtime-audit.test.tsの5件、4デッキ追加ではfour-deck.test.tsの6件を追加した。

4デッキ対応時のクリーン検証は親エージェントがscripts/validate-release.mjsで74件構成のsourceに対して実施した。optional依存を省くnpm ci --offline後のbuild/testは73 pass / 1 skip / 0 fail。配布にはローカル実機キャプチャを含めないため、その任意回帰テスト1件がskipとなる。配布tarを別フォルダへ展開し、production依存のみで4デッキdemoを起動する検証も成功した。HTTP/UI、全4デッキのOSC実UDP valid=1、終了時の全4デッキvalid=0と正常終了を確認した。環境はmacOS arm64 / Node.js26.0.0。Node.js22.18以降を要求するが、今回の実行環境以外のOS・CPU・Node版での配布認証は未実施。

## 接続先切替・OSC設定変更の追加監査

機器モデル、IF、接続方法のプルダウンがPOST APIへ渡り、実際のセッション生成に反映されることを確認した。通常起動は未接続のidleで、選択を変えただけでは参加せず、「接続」で開始する。宣伝見出しとテンポ履歴パネルを取り除き、XDJ受信情報と接続・OSC設定を中心とする画面へ変更した。

| 対象 | 追加した検証 |
|---|---|
| 接続切替 | 旧source終了後に新sourceを作る。新しいsessionIdとsnapshotへ切り替え、旧sourceの遅い状態・エラーはhubへ混入しない。 |
| 接続中の操作 | startupは非同期に進行する。重なる設定変更は409、終了後は503。遅延startupが終了後にhandleを返しても、そのcloseが完了するまでアプリの終了を待つ。 |
| ネットワーク解放 | nativeのabort listenerが先にcloseを開始した場合も、再入したcloseはUDP解放の完了を待つ。mock socketsで3ソケットのcallback完了前に切替へ進まないことを確認。 |
| OSC切替 | 実UDPで旧valid1→より大きいrevisionのvalid0→さらに大きいrevisionの新valid1を確認。同一宛先への再適用でも単調性を維持する。XDJの値・observedAt・quality・freshnessを変更しない。 |
| OSC設定失敗 | 新output生成の失敗を注入し、旧宛先へ復帰することを確認。旧outputは無効化され、新outputはfresh値と後続revisionを持つ。 |
| 設定API境界 | Host/Origin、application/json、4KiB上限を検証。Content-Lengthなしのchunked要求にも上限を適用する。このMacの非loopbackアドレス経由ではGETは成功し、設定POSTは403でmutation回数0。 |
| WebSocket | セッション変更時の最初の通知は完全snapshot。新セッションに旧deckを残さず、旧sourceの遅い通知も送らない。 |

追加監査で、abort起点のcloseへ再入すると元のUDP解放を待たずに戻る競合と、OSC旧宛先の無効化が直前のvalid1と同じrevisionになる問題を検出した。closeのPromise共有と、OSC切替前後のrevision更新で修正し、独立テストで確認した。

親エージェントは実ブラウザでも未接続の初期画面、RX3と実在IFの選択、選択だけでは未接続を保つこと、OSCポート9001への適用と9000への復帰、未適用の接続選択の保持を確認した。console error/warnはなかった。機器への参加は実施していない。

## ハンバーガーメニュー・表示安定化の追加監査

接続先とOSC設定を、初期状態では閉じた右側のnative dialogへ移動した。既存formのDOMとIDを維持し、ハンバーガー・閉じるボタンをtype=buttonとすることで開閉によるsubmitを防ぐ。開閉処理にPOSTや設定の初期化はなく、未適用の入力を保持する。aria-expanded、フォーカス復帰、背景スクロール抑制、100dvh内の内部スクロール、小画面幅の制限をコード確認した。Escapeとモーダル内のフォーカス制御はnative dialogを使用する。

高頻度受信でデッキDOMを毎回取り外す処理を差分反映へ変更し、変わらない文字列・BPM断片・能力・診断を再作成しない。最新状態を50ms単位で集約して描画する。IF一覧はソート・重複除去し、既存optionを再利用する。選択中のIF一覧は更新を保留し、選択操作の終了後に最新の一覧へ反映する。native selectのpopup展開時にfocusがdialogへ移る場合も、pointer/keyboard操作のラッチで更新を保留する。

追加のtests/ui.test.tsを監査者も実行し、6件すべて成功した。デッキDOM・details・focusの保持、受信バーストの描画集約と最新BPM、IF一覧の安定とfocus中の更新保留、メニュー開閉時の未適用入力保持とPOSTなし、WS再接続時のstale復元、native popupのfocus移動中のoption保持を検証する。JavaScript構文検査も成功。linkedomは固定した開発依存のみで、製品ランタイム依存には追加していない。今回のコード監査で追加の要修正所見はなかった。

親エージェントは実ブラウザでも、既存のRX3受信を継続したままメニュー開閉、Escape、未適用入力の保持を確認した。画面確認のために接続やOSC設定を変更していない。

## 接続メッセージ表示の追加監査

デッキの直前で表示・非表示を繰り返していたsession-reasonを除き、接続状態は常設の固定幅76px・高さ24pxの状態バッジへ変更した。理由の原文は折り畳み診断内の「直近の接続メッセージ（過去の記録）」に表示する。非空理由をWS受信時に記憶し、nullでは消去せず、同文は再描画しない。sessionId変更時は記録をリセットする。理由だけの更新でruntimeを再取得しないこともコード確認した。

追加3件を含むUI9件を監査者も実行し、全件成功した。理由とnullの高速交互受信でもデッキ・周辺DOM・状態バッジが安定すること、診断内での理由保持とセッション切替時のリセット、同一描画フレーム内の理由→nullの保持を検証する。JavaScript構文検査も成功し、今回の差分に重大所見はなかった。新規の実機接続やOSC設定変更は行っていない。

親エージェントは実ブラウザで既存のRX3受信を維持し、固定の「受信中」バッジ、旧inline行がないこと、診断を開いた時に状態・en6・直近メッセージを確認できることを検証した。console error/warnはなく、画面プレビューも更新した。

## 曲名拡大・再生枠・4デッキの追加監査

曲名20px・artist16px（狭幅18px・15px）、最大2行と全文tooltipを確認した。枠はfreshかつqualityが既知のplaying/looping/cue_playingだけを強調し、停止・不明・null・staleでは解除する。色はDOMの到着順ではなくlogicalDeckの1〜4に固定する。4デッキの順不同到着・欠落・再接続でも、既存カード・details・focusとメタデータを維持するUI回帰が成功した。

独立監査で、AZのsource番号1より先に4/3/2の状態が届くと共有媒体ownerが分裂し、USB交換時に旧title/artistを解除できない不具合を再現した。後着のownerを実際に観測した時点で既存の未解決参照を統一し、旧要求の世代を無効化する修正を確認した。未確認の番号範囲だけで外部CDJの媒体を同じ本体へ吸収しないことも検証した。

追加の独立4件では、後着sourceとUSB交換での旧メタデータ棄却、公開ID az1〜az4のOSCルーティング、deck4だけのstale/復帰、deck3だけの曲切替、外部source保持を確認した。実装担当の4デッキ6件は合成rawパケット480件、4台のCDJ、混在2+4デッキ、設定検証、runtime、WS/実UDPへの配信を検証する。4デッキのデモは明示指定時だけで、RX3の既定2デッキと未取得メタデータを維持する。AZの実機対応は未検証のままとする。

親エージェントのブラウザQAでは、1200×1000で4デッキが2列×2段、390×844で縦積みとなり横overflowがないこと、fresh再生中のdeck1/3だけに色枠が付くことを確認した。監査者も合成データのデスクトップ画像を確認した。合成の曲名・artistを含む表示QAは、機器からのメタデータ直接取得の実証には含めない。

最終更新時は、親エージェントが8080の実行プロセスとruntimeを読み、未接続・接続処理なし・en6利用不可のエラー・OSC無効を確認した。その後、8080プロセスを最新版へ更新し、RX3/en6の選択を保持したidle・OSC無効で起動した。実ブラウザでメニュー閉・未接続・console error/warnなしを確認した。実機への接続やOSC有効化は行っていない。実装・監査サブエージェントは受信プロセスと実機設定を変更していない。

## 代表デッキOSCの追加監査

ユーザーが指定した「テンポMASTERを優先し、取得できなければ再生中から選ぶ」規則を、共通の正規化状態から適用する。MASTERはlocal primary sourceのalphatheta-connect `src/status/utils.ts`とbeat-link `CdjStatus.java`で、status byte 0x89のbit 0x20として解釈されていることを確認した。入力は整数byteのstatusFlagsまたは公開status APIのbooleanだけを認め、欠落・不正値をfalseへ補わない。既存受理形式のsubtype 3/4/5・最小長0xccは維持する。親のレビューで、204〜211byteの既存受理statusだけMASTERを拾わない旧0xd4ガードを検出した。0x89は最小長0xccでも存在し、一次sourceも0xc8から同byteを読むため、この余分なguardを除去した。0xcc〜0xd3の全長と3形式、最小長未満と未知形式の拒否を回帰検証する。モデル/FWの実機確認済みという表示へは昇格させない。

freshかつobservedのMASTERがあれば、停止や未知BPMでもそのデッキを代表とする。代表の存在とBPMの利用可否は独立し、未知BPMは`/bpm/valid=0`で値を省略する。MASTERがなければ、freshな再生状態と有効な実効BPMを持つデッキから選ぶ。同順位は現在の代表を維持し、候補から外れた時だけ決定的な順序で切り替える。公開IDが未確定・重複中のデッキ、別セッションのデッキ、staleな値は代表候補から外す。切断・候補なしでは代表を解除する。

独立した`tests/representative-audit.test.ts`の6件を実行し、6 pass / 0 fail / 0 skipを確認した。MASTER優先とBPMの独立無効化、多重MASTERからの引継ぎ、MASTER情報欠落時の安定したfallback、部分的な受信途絶、公開ID衝突、不正flag、切断した私有OSC view、OSC同一宛先への再適用時のvalid=1→後続revisionのvalid=0→さらに後続revisionのvalid=1を検証する。私有OSC viewの無効化で元の代表・観測値・鮮度が変わらないことも確認した。

実UDPの分割snapshotでは、全bundleにsession/revisionと代表の短いpublic_deck_id・valid・reasonを反復する。長いcapture IFから生成された内部deck_idを全bundleに反復すると512byteの曲名/artistが送信から落ちる境界を独立testで再現した。内部deck_idは通常のvalid/quality/fresh付き値として送り、512byteを超える場合はvalid=0で旧値を無効化する修正後、全datagramが1200byte以下で、代表BPMと512byteの曲名/artistが失われないことを確認した。代表無し・終了時はvalid=0とreason=noneを送り、古い代表BPMを値0として送らない。既存のデッキ別OSC出力も維持する。

今回の独立監査では8080のプロセス、実機接続、ユーザーのOSC送信先・有効設定を変更していない。実機のテンポMASTER切替と表示・音の対応付けは未検証である。同時進行の通知機能に関する変更は保持し、この代表ルートの監査範囲とは区別する。

親の全体suiteで、通知停止をawaitしてから取得処理をabortする統合変更により、`RuntimeController.close()`の即時abort保証が失われる回帰を検出した。通知の同期unsubscribe/cancelを開始し、同じ同期呼出し内でsourceAbortを発火してから両方の終了を待つ最小修正を適用した。既存のauditを緩めず、通知8件・runtime-audit5件・代表独立6件の19件を再実行し全件成功した。通知のnative送信やユーザー設定の有効化は行っていない。

代表ルート追加後、親は最新103件構成でクリーン検証を再実行した。optional依存を省いたsourceのbuild/testは102 pass / 1 skip / 0 failで、skipは配布に含めないローカル保存キャプチャの任意回帰1件である。配布tarを別フォルダへ展開し、production依存のみで起動してHTTP/UI、4デッキの全個別経路と代表OSCの実UDP送信、全fragmentの短い代表identity、終了時の最終valid=0、正常終了を確認した。

親は動作中8080の更新前に、PIDと起動commandが前回のアプリに一致し、idle・接続処理なし・OSC無効・通知無効であることをAPIで確認した。SIGTERMで終了後、最新版を同じ`--profile xdj-rx3 --interface en6`で起動した。更新後のAPIは代表なし・reason=none、RX3/en6選択保持、接続idle/errorなし、OSC 127.0.0.1:9000・20Hz・無効、通知無効/supported=true/errorなしだった。更新作業で実機接続、OSC有効化、OS通知送信は行っていない。

## OS通知の追加監査

backendのfake送信8件、監査専用notifications-audit.test.tsの7件、UI14件を確認した。独立監査7件は全件成功。固定AppleScript・argv境界と文字数上限、1000同状態更新、4デッキ独立、初回・ON・session/load変更・unknown/estimated/stale復帰のbaseline、待機上限・単一送信枠、OFF/ONとcloseの競合、送信/診断例外の隔離、設定APIのJSON・size・Origin・非loopback拒否を検証した。実OS通知は送っていない。

親の最終全suiteは110 pass / 0 fail / 0 skip、clean sourceは109 pass / 1 skip / 0 failだった。skipはローカル実機キャプチャの任意回帰1件。配布runtimeの通知既定OFF・supported bool・error=null、HTTP/UI、4デッキ個別・代表OSC、終了時valid=0を確認した。AppleScriptは実macOSで構文コンパイルのみ成功し、実OS通知・バナー表示・OSの通知許可は未確認。osascriptの正常終了も実表示の確認には扱わない。[Appleの仕様](https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/DisplayNotifications.html)とOS設定に従う。

別作業で最新版へ反映済みの8080を親が再起動せず確認した。RX3/en6選択・OSC無効・idle・デッキ0のまま、通知は選択だけではOFFを保ち、適用でON→OFFへ戻った。実通知ゼロ、console error/warnなしで、メニューも閉じて戻している。今回の通知監査で実機接続・8080プロセス・OSC設定を変更していない。重大所見はなかった。

## LAN内機器探索・受信経路の追加監査

選択するネットワーク接続は1台の機器専用ではなくLAN全体であり、同一IFの複数CDJ/XDJを送信元IP・通信番号で分けて扱うことを確認した。独立した`tests/discovery-audit.test.ts`の13件が成功した。模擬UDPでは、探索が50000の受信ソケット1個だけを開き送信ゼロであること、同じ通信番号でも別IPを潰さないこと、自己・別IF・不正長・不明layout・通知内IP不一致を除外すること、異サブネットの通知をIF未確定とすることを検証した。synthetic Ethernet/VLANからの観測、最大128件・6秒超の失効・復帰も確認した。

受信のみの50002をwildcard bindへ変更し、仮想参加の50002は選択IPv4 bindを維持した。複数peerへのunicast参加はmock送信先と回数で検証し、RX3の既存パケットfixtureは保持している。一次実装の比較ではbeat-linkは50000をwildcard・50002を選択IPv4へbindし、alphatheta-connectは3ポートともwildcardを使う。従って旧50002 bindによるbroadcast受信欠落の可能性と、Windows・スイッチ・AZでの取得失敗原因の確定は区別する。Node UDPで受信IFや送信先IPを取得できない制約は残り、サブネット照合はIFの証明ではない。mixerのtype1は対象を証明できず診断のみとし、type3は正規形式・番号・参加中に限定した停止条件を確認した。

独立監査で、探索中のIF消失・IP変更・後発の経路重複が旧IFへ誤帰属する問題、終了を先行させた同一turnで探索が後から開始される競合、旧探索結果が新セッションの一覧を隠す問題を検出し、修正後に回帰を確認した。親が指摘した取得失敗後の探索再開も、旧sourceの解放完了前に新ソケット所有を始めないことを検証した。既存liveの同IF探索はソケットを追加せず、別IFは409、探索中の接続も409となる。探索専用storeからhub・OSC・OS通知へデッキ値を混入させず、終了はabortと解放を待つ。localhostのHTTP/WSでJSON・size・Host/Origin・busy・終了後拒否、devicesのdeltaとstale配信も確認した。

現場は別のWindows PCにスイッチ経由で接続されたXDJ-AZであり、このMacには接続されていない。今回のLAN検証で実LAN探索・実機参加・ユーザーのOSC設定変更・実OS通知は行っていない。AZの[公式設定マニュアル](https://downloads.support.alphatheta.com/manuals/all-in-one-dj-systems/XDJ-AZ/html/en/000COV_en/Settings/Settings.htm)はPRO DJ LINK ModeをOnにするとDeck 3/4を使えないと明記するため、4デッキの合成検証をAZのLAN4デッキ取得保証とは扱わない。Windows上での実行・ファイアウォール・現場ネットワークの確認は未実施で、報告された失敗原因も未確定である。

今回のbackend追加6件・独立監査13件・UI追加3件を含む親の全suiteは132 pass / 0 fail / 0 skipだった。clean sourceは131 pass / 1 skip / 0 failで、skipは配布に含めないローカル保存キャプチャの任意回帰1件。production依存のみの配布runtimeでもHTTP/UI、4デッキ個別・代表OSCのUDP送信とfragment identity、終了時valid=0、正常終了を確認した。

親のブラウザ確認は合成データだけを使用し、AZの同一IP・番号1/2、別IPのCDJ、IF未確定の異サブネット通知の計4件を区別して表示できた。日本語の理由文を含む[探索表示例](docs/network-discovery.png)を保存し、console error/warnはなかった。親はもともと停止していた8080の空きを確認し、最新版をidle/native・OSC無効・OS通知無効で起動した。実LAN探索・参加は開始していない。

## AZ Mode OFF向け試験モードの追加監査

現場のFW 1.23 / Windowsは、参考実装のFW 1.30とは別の未検証条件である。`az-standalone`は明示選択時だけPC型presenceを試し、本体Mode OFF・FW・従来方式を自動変更しない。観測されたfield factsから54byte/layout3/PC role4/末尾8/count1を既存encoderで独立構築し、参照リポジトリのコードは取り込んでいない。送信先は選択サブネットbroadcastと観測したAZのunicastに限定し、選択IPv4の専用一時送信ポートと50002状態受信を分ける。CDJ claim、Lighting、Stagehand要求、global broadcastは送らない。

独立した`tests/az-standalone-audit.test.ts`の11件が成功し、既存runtime-audit5件・discovery-audit13件を合わせた29件も成功した。候補packet、5→6の空き番号選択、占有・他機種混在時の送信拒否、6秒の無送信観測、1.5秒間隔と初回10秒無返信停止、AZだけの入力境界、4つの合成デッキとOSC終了valid=0、APIの入力拒否・無fallback、実UIの選択だけではPOSTしないことを確認した。独立監査でbind待機中の取消が永久待ちになる競合と、初回send待機中の取消後にheartbeatを作る競合を指摘し、修正後に回帰を確認した。追加送信ソケットを含む4つすべての解放完了を待つ。

検証はfake UDP・合成状態・このPC内のHTTP/UIで、監査サブエージェントは実LAN探索・実機への送信・8080操作・FW変更を行っていない。FW 1.23でのwake、Mode OFFの4デッキ取得、曲名や解析との対応付けを達成した証拠ではない。「全情報」の取得保証はせず、未取得値をnull/未検証に保つ。一次資料の比較・限界・実機照合条件は[AZ OFF運用の調査記録](docs/AZ-OFF-RESEARCH-20261031.md)を参照する。

今回のbackend追加7件・独立監査11件・UI追加2件を含む親の全suiteは152 pass / 0 fail / 0 skipだった。clean sourceは151 pass / 1 skip / 0 failで、skipは配布外のローカル保存キャプチャfixtureの任意回帰1件。runtime.tar.gzを展開し、production依存だけのオフライン導入でもHTTP/UI、4つの合成デッキ、個別・代表OSCのUDP送信、fragment identity、終了時valid=0を確認した。これらはWindows実行・FW1.23実機取得の検証ではない。

親は8080がidle・OSC/OS通知無効・探索なしであることを確認し、最新版をidleで起動して画面を確認した。「XDJ-AZ」「AZスタンドアロン（試験）」の選択だけでOFF維持・実機未検証の説明が表示され、接続・探索は開始していない。IFは未選択でruntimeもidleのまま、console error/warnなし。[設定画面](docs/az-standalone-settings.png)を保存し、メニューを閉じて待機画面へ戻した。

## 監査で検出して修正した事項

- コンパイル後の静的資産パス不一致によるUIの404、空snapshot後の旧カード残留、機能単独のstale表示漏れ。
- 分割OSC bundleの後続にrevisionが付かない問題と、終了時にpendingの無効化通知が破棄される問題。全bundleにヘッダを反復し、終了時flushの完了を待つ。
- 有効beatの受信、位置ストリームの途絶、媒体交換・切断に対してCapability利用状態が追従しない問題。検証履歴を保持しながら現在の利用状態を更新する。
- 秒切捨ての曲長によって最後の999msの絶対位置が不正扱いとなる問題。
- ライブ終了時の人工的な60秒加算、状態通知から観測した番号が番号選択に反映されない問題、開始後のIF重複・IP/netmask変更の再評価不足。
- 空白を含むworkspaceパスで配布スクリプトが失敗する問題と、optionalライブラリを省くと型解決がビルドを妨げる問題。

## 実装範囲と残る検証

RX3の曲名・アーティストを直接取得する標準Provider、AZのNFS/dbserver Provider、波形・beat grid・cue、機種別MixerDecoder、自動再参加は未実装。MetadataProvider差込口と有限スケジューラを提供する。未取得値はnullを維持し、曲名の直接取得達成やAZ全機能対応を表示しない。

native UDPは送信元IPv4を固定する。Node標準APIにmacOSのIP_BOUND_IFがないため、サブネットが重なるIFを起動時と稼働中に拒否する。厳密なIF束縛が必要な受動監視では、明示IFのpcapを使用する。ライブ値と実機操作の照合、実機番号競合・USB交換・ケーブル抜差し、AZの4デッキと各機能は後続の実機受入対象である。

RX3 Toolkit、本体モジュール、ファームウェアへの変更は行っていない。DJのUSBデータベースの事前コピーを運用要件に追加していない。
