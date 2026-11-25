import { useState, useEffect, useRef } from 'react';
import {
  collection,
  addDoc,
  serverTimestamp,
  onSnapshot,
  query,
  orderBy,
  doc,
  updateDoc,
  deleteDoc,
  arrayUnion,
} from 'firebase/firestore';
import { signInWithPopup, signOut, onAuthStateChanged, type User } from 'firebase/auth';
import { db, auth, provider } from './firebase';

const GEMINI_API_KEY = (import.meta.env.VITE_GEMINI_API_KEY || '')
  .replace(/['"`\s]/g, '')
  .trim();

type RiskLevel = '通常' | '要注意' | '高リスク';
type ActionStatus = '未着手' | '対応中' | '完了';
type ActionPriority = '通常' | '急ぎ';
type MemberRole = '部員' | '部長';
type ActionOwner = '部長' | '部員';

interface FirestoreTimestamp {
  toDate?: () => Date;
}

interface Member {
  id: string;
  name: string;
  email: string;
  department: string;
  role: MemberRole;
  managerEmail?: string;
}

interface AISummaryResult {
  overview: string;
  issues: string;
  background: string;
  direction: string;
  managerActions: string[];
  memberActions: string[];
  nextActions?: string[]; // 過去データ互換用
  riskLevel: RiskLevel;
}

interface OneOnOneLog {
  id: string;
  meetingDate: string;
  memberName: string;
  memberEmail: string;
  department: string;
  managerName: string;
  managerEmail: string;
  rawMemo: string;
  privateMemo?: string;
  transcript: string;
  docUrl?: string;
  aiSummary: AISummaryResult;
  createdAt?: FirestoreTimestamp | null;
}

interface ActionHistoryItem {
  id: string;
  type: 'comment' | 'status' | 'priority';
  text: string;
  actorName: string;
  createdAtLabel: string;
}

interface ActionItem {
  id: string;
  logId?: string;
  meetingDate?: string;
  title: string;
  detail: string;
  status: ActionStatus;
  priority: ActionPriority;
  owner: ActionOwner | '両方';
  memberName: string;
  memberEmail: string;
  department: string;
  managerName: string;
  managerEmail: string;
  history?: ActionHistoryItem[];
  createdAt?: FirestoreTimestamp | null;
}

interface BrowserSpeechRecognitionEvent {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
}

interface BrowserSpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionCtor = new () => BrowserSpeechRecognition;

const getTodayISO = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const getCurrentMonthPrefix = () => getTodayISO().slice(0, 7);

const getNowFullLabel = () =>
  new Date().toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

const formatTimestamp = (ts?: FirestoreTimestamp | null) => {
  if (!ts || typeof ts.toDate !== 'function') return 'たった今';
  return ts.toDate().toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

// 会話ログの1行から「話者名」と「発言内容」を分離
const parseTranscriptLine = (
  line: string,
  managerName: string,
  memberName: string
): { speaker: string; body: string; role: 'manager' | 'member' | 'unknown' } => {
  const match = line.match(/^([^：:]{1,24})[：:]\s*(.+)$/);
  if (!match) {
    return { speaker: '', body: line, role: 'unknown' };
  }
  const speaker = match[1].trim();
  const body = match[2].trim();
  if (
    speaker === '部長' ||
    speaker.includes('マネージャー') ||
    (managerName && speaker.includes(managerName))
  ) {
    return { speaker, body, role: 'manager' };
  }
  if (
    speaker === '部員' ||
    (memberName && speaker.includes(memberName))
  ) {
    return { speaker, body, role: 'member' };
  }
  return { speaker, body, role: 'unknown' };
};

// バックアップ自動要約（部長用・対象者用アクションを分離して生成）
const buildFallbackSummary = (
  memberName: string,
  rawMemo: string,
  transcript: string
): AISummaryResult => {
  const combined = `${rawMemo}\n${transcript}`.trim();
  const lines = combined
    .split(/[\n。]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);

  const highRiskWords = ['転職', '退職', '辞めたい', '限界', '離職', '休職', 'メンタル'];
  const warnWords = ['不安', '合わない', 'ミスマッチ', '残業', '忙しい', 'きつい', '異動', '不満'];

  const hasHighRisk = highRiskWords.some((w) => combined.includes(w));
  const hasWarn = warnWords.some((w) => combined.includes(w));
  const riskLevel: RiskLevel = hasHighRisk ? '高リスク' : hasWarn ? '要注意' : '通常';

  const issueLines = lines.filter((l) =>
    /課題|不安|転職|退職|合わない|困って|忙しい|残業|希望|悩み|改善|難しい/.test(l)
  );

  const overview =
    lines.length > 0
      ? `${memberName}さんとの1on1を実施。${lines.slice(0, 2).join('。')}。`
      : `${memberName}さんとの定期1on1を実施し、業務状況と今後の方向性を確認した。`;

  const issues =
    issueLines.length > 0
      ? issueLines.slice(0, 2).join('。') + '。'
      : rawMemo.trim() || '大きな阻害要因は顕在化していないが、継続的な業務負荷の確認が必要。';

  const background =
    transcript.trim().length > 30
      ? '面談内の発言内容より、現在の担当業務・環境面でのギャップや負荷状況が背景にあると推察される。'
      : '日々の業務進行とキャリア志向のすり合わせ過程で挙がった内容。';

  const direction = hasHighRisk
    ? '本人の強みやキャリア志向を丁寧に再確認し、業務内容の再調整や配置転換の可能性も含めて継続活躍できる環境を早急に検討する。'
    : hasWarn
    ? '業務負荷や役割のミスマッチを早期に解消するため、定期的なフォローと業務配分の見直しを進める。'
    : '現在の強みを伸ばしつつ、来月に向けた具体的な目標とサポート体制を維持する。';

  const managerActions = hasHighRisk
    ? [
        `${memberName}さんの強みを活かせる業務再配分・配置転換案を関係部署と検討する`,
        '2週間以内にキャリア志向を深掘りするフォロー面談を設定する',
      ]
    : hasWarn
    ? [
        `${memberName}さんの現在の業務負荷と優先度を見直す調整を行う`,
        '次回1on1までに改善状況の中間確認を入れる',
      ]
    : [`${memberName}さんの成長目標に沿った業務アサイン・サポートを継続する`];

  const memberActions = hasHighRisk
    ? [
        'これまでの業務で「やりがいを感じた仕事」と「今後挑戦したい領域」を3点整理する',
        '現在の業務で負担が大きい作業を書き出し、次回面談で共有する',
      ]
    : hasWarn
    ? [
        '現在抱えている業務の中で改善したい・手放したい作業をリストアップする',
        '来月に向けた優先タスクの進め方を整理する',
      ]
    : ['今月の振り返りと来月チャレンジしたい目標を1〜2点まとめる'];

  return {
    overview,
    issues,
    background,
    direction,
    managerActions,
    memberActions,
    riskLevel,
  };
};

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'record' | 'board' | 'members'>(
    'overview'
  );

  // Firestoreデータ
  const [members, setMembers] = useState<Member[]>([]);
  const [logs, setLogs] = useState<OneOnOneLog[]>([]);
  const [actions, setActions] = useState<ActionItem[]>([]);

  // 実施状況＆ログ詳細用State
  const [selectedMonth, setSelectedMonth] = useState(getCurrentMonthPrefix());
  const [overviewDeptFilter, setOverviewDeptFilter] = useState('すべて');
  const [overviewSearch, setOverviewSearch] = useState('');
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);

  // 1on1記録・録音・AI要約フォーム用State
  const [meetingDate, setMeetingDate] = useState(getTodayISO());
  const [selectedMemberId, setSelectedMemberId] = useState('');
  const [manualMemberName, setManualMemberName] = useState('');
  const [manualMemberEmail, setManualMemberEmail] = useState('');
  const [manualDepartment, setManualDepartment] = useState('');
  const [rawMemo, setRawMemo] = useState('');
  const [privateMemo, setPrivateMemo] = useState('');
  const [transcript, setTranscript] = useState('');
  const [docUrl, setDocUrl] = useState('');

  // リアルタイム音声認識 ＋ 話者切替State
  const [isRecording, setIsRecording] = useState(false);
  const [interimText, setInterimText] = useState('');
  const [currentSpeaker, setCurrentSpeaker] = useState<'manager' | 'member'>('member');
  const currentSpeakerRef = useRef<'manager' | 'member'>('member');
  const speakerNamesRef = useRef<{ manager: string; member: string }>({
    manager: '部長',
    member: '部員',
  });
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const keepRecordingRef = useRef(false);

  // AI要約結果・編集State（部長用・部員用を分離）
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState<AISummaryResult | null>(null);
  const [selectedManagerActions, setSelectedManagerActions] = useState<boolean[]>([]);
  const [selectedMemberActions, setSelectedMemberActions] = useState<boolean[]>([]);
  const [isSavingLog, setIsSavingLog] = useState(false);

  // 課題ボード用State
  const [boardSearch, setBoardSearch] = useState('');
  const [boardDeptFilter, setBoardDeptFilter] = useState('すべて');
  const [boardUrgentOnly, setBoardUrgentOnly] = useState(false);
  const [selectedActionId, setSelectedActionId] = useState<string | null>(null);
  const [modalCommentText, setModalCommentText] = useState('');
  const [isPostingComment, setIsPostingComment] = useState(false);

  // 部員マスタ管理（追加・編集・一括取り込み）用State
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberEmail, setNewMemberEmail] = useState('');
  const [newMemberDept, setNewMemberDept] = useState('');
  const [newMemberRole, setNewMemberRole] = useState<MemberRole>('部員');
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [editMemberForm, setEditMemberForm] = useState<{
    name: string;
    email: string;
    department: string;
    role: MemberRole;
  }>({ name: '', email: '', department: '', role: '部員' });
  const [bulkPasteText, setBulkPasteText] = useState('');
  const [isBulkImporting, setIsBulkImporting] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const unsubMembers = onSnapshot(collection(db, 'members'), (snap) => {
      setMembers(snap.docs.map((d) => ({ id: d.id, ...d.data() })) as Member[]);
    });
    const unsubLogs = onSnapshot(
      query(collection(db, 'oneOnOneLogs'), orderBy('createdAt', 'desc')),
      (snap) => {
        setLogs(snap.docs.map((d) => ({ id: d.id, ...d.data() })) as OneOnOneLog[]);
      }
    );
    const unsubActions = onSnapshot(
      query(collection(db, 'oneOnOneActions'), orderBy('createdAt', 'desc')),
      (snap) => {
        setActions(snap.docs.map((d) => ({ id: d.id, ...d.data() })) as ActionItem[]);
      }
    );
    return () => {
      unsubMembers();
      unsubLogs();
      unsubActions();
    };
  }, []);

  // 話者ラベルを最新の状態に同期
  useEffect(() => {
    currentSpeakerRef.current = currentSpeaker;
  }, [currentSpeaker]);

  useEffect(() => {
    const found = members.find((m) => m.id === selectedMemberId);
    speakerNamesRef.current = {
      manager: user?.displayName || '部長',
      member: found?.name || manualMemberName.trim() || '部員',
    };
  }, [user, members, selectedMemberId, manualMemberName]);

  useEffect(() => {
    return () => {
      keepRecordingRef.current = false;
      recognitionRef.current?.stop();
    };
  }, []);

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, provider);
    } catch {
      alert('ログインに失敗しました');
    }
  };

  const handleLogout = async () => {
    if (confirm('ログアウトしますか？')) await signOut(auth);
  };

  // =========================================
  // 🎙️ リアルタイム録音＆話者ラベル付き文字起こし
  // =========================================
  const handleStartRecording = () => {
    const win = window as unknown as {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    const SpeechRec = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (!SpeechRec) {
      alert(
        'お使いのブラウザはリアルタイム音声文字起こしに対応していません。Google Chrome または Microsoft Edge をご利用ください。'
      );
      return;
    }

    const recognition = new SpeechRec();
    recognition.lang = 'ja-JP';
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let finalChunk = '';
      let interimChunk = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) {
          finalChunk += res[0].transcript;
        } else {
          interimChunk += res[0].transcript;
        }
      }
      setInterimText(interimChunk);
      if (finalChunk.trim()) {
        const label =
          currentSpeakerRef.current === 'manager'
            ? speakerNamesRef.current.manager
            : speakerNamesRef.current.member;
        const formattedLine = `${label}：${finalChunk.trim()}`;
        setTranscript((prev) => (prev ? `${prev}\n${formattedLine}` : formattedLine));
      }
    };

    recognition.onerror = (event) => {
      if (event.error === 'not-allowed') {
        alert(
          'マイクの使用が許可されていません。ブラウザのアドレスバーからマイクを許可してください。'
        );
        keepRecordingRef.current = false;
        setIsRecording(false);
        setInterimText('');
      }
    };

    recognition.onend = () => {
      if (keepRecordingRef.current) {
        try {
          recognition.start();
        } catch {
          setIsRecording(false);
        }
      } else {
        setIsRecording(false);
        setInterimText('');
      }
    };

    recognitionRef.current = recognition;
    keepRecordingRef.current = true;
    setIsRecording(true);
    recognition.start();
  };

  const handleStopRecording = () => {
    keepRecordingRef.current = false;
    recognitionRef.current?.stop();
    setIsRecording(false);
    setInterimText('');
  };

  // =========================================
  // 🤖 AI要約生成（部長用／部員用ネクストアクション分離）
  // =========================================
  const getTargetMemberInfo = () => {
    const found = members.find((m) => m.id === selectedMemberId);
    if (found) {
      return {
        name: found.name,
        email: found.email.toLowerCase(),
        department: found.department,
      };
    }
    return {
      name: manualMemberName.trim(),
      email: manualMemberEmail.trim().toLowerCase(),
      department: manualDepartment.trim() || '未設定',
    };
  };

  const applySummaryDraft = (result: AISummaryResult) => {
    setSummaryDraft(result);
    setSelectedManagerActions(result.managerActions.map(() => true));
    setSelectedMemberActions(result.memberActions.map(() => true));
  };

  const handleGenerateSummary = async () => {
    const target = getTargetMemberInfo();
    if (!target.name) {
      alert('先に対象の部員を選択（または氏名を入力）してください。');
      return;
    }
    if (!rawMemo.trim() && !transcript.trim()) {
      alert('ざっくりメモ、または会話ログ（文字起こし）を入力してください。');
      return;
    }

    setIsSummarizing(true);
    try {
      if (GEMINI_API_KEY) {
        const prompt = `あなたはマネジメント支援AIです。以下の1on1面談の「ざっくりメモ」と「会話ログ全文」を分析し、面談記録と、部長側・対象部員側それぞれのネクストアクションを構造化JSONのみで出力してください。

【対象部員】${target.name}（${target.department}）
【ざっくりメモ】
${rawMemo || 'なし'}
【会話ログ全文】
${transcript || 'なし'}

【出力JSON形式】
{
  "overview": "面談全体の簡潔な要約（1〜2文）",
  "issues": "現状の課題",
  "background": "課題の背景・要因",
  "direction": "解決に向けた方向性・サポート方針",
  "managerActions": ["部長側が取り組むネクストアクション1", "部長側アクション2"],
  "memberActions": ["対象部員本人が取り組むネクストアクション1", "部員側アクション2"],
  "riskLevel": "通常 または 要注意 または 高リスク"
}`;

        const url =
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' +
          GEMINI_API_KEY;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json' },
          }),
        });

        if (response.ok) {
          const data = await response.json();
          const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
          const parsed = JSON.parse(rawText.replace(/```json\n?|\n?```/g, '').trim()) as Partial<
            AISummaryResult
          >;
          const normalized: AISummaryResult = {
            overview: parsed.overview || '',
            issues: parsed.issues || '',
            background: parsed.background || '',
            direction: parsed.direction || '',
            managerActions: Array.isArray(parsed.managerActions) ? parsed.managerActions : [],
            memberActions: Array.isArray(parsed.memberActions) ? parsed.memberActions : [],
            riskLevel:
              parsed.riskLevel === '高リスク' || parsed.riskLevel === '要注意'
                ? parsed.riskLevel
                : '通常',
          };
          applySummaryDraft(normalized);
          return;
        }
      }

      const fallback = buildFallbackSummary(target.name, rawMemo, transcript);
      applySummaryDraft(fallback);
    } catch {
      const fallback = buildFallbackSummary(target.name, rawMemo, transcript);
      applySummaryDraft(fallback);
    } finally {
      setIsSummarizing(false);
    }
  };

  // =========================================
  // 💾 1on1ログ保存 ＋ 部長用・対象者用アクションを個別登録
  // =========================================
  const handleSaveOneOnOne = async () => {
    if (!user) return;
    const target = getTargetMemberInfo();
    if (!target.name || !target.email) {
      alert('対象部員の氏名とメールアドレスを入力（またはマスタから選択）してください。');
      return;
    }

    const finalSummary =
      summaryDraft || buildFallbackSummary(target.name, rawMemo, transcript);

    setIsSavingLog(true);
    try {
      const managerEmail = (user.email || '').toLowerCase();
      const managerName = user.displayName || '部長';

      const cleanManagerActions = finalSummary.managerActions.filter((t) => t.trim());
      const cleanMemberActions = finalSummary.memberActions.filter((t) => t.trim());

      const logRef = await addDoc(collection(db, 'oneOnOneLogs'), {
        meetingDate,
        memberName: target.name,
        memberEmail: target.email,
        department: target.department,
        managerName,
        managerEmail,
        rawMemo: rawMemo.trim(),
        privateMemo: privateMemo.trim(),
        transcript: transcript.trim(),
        docUrl: docUrl.trim(),
        aiSummary: {
          ...finalSummary,
          managerActions: cleanManagerActions,
          memberActions: cleanMemberActions,
        },
        createdAt: serverTimestamp(),
      });

      const defaultPriority: ActionPriority =
        finalSummary.riskLevel === '高リスク' ? '急ぎ' : '通常';

      const managerItemsToSave = finalSummary.managerActions
        .filter((text, idx) => text.trim() && (selectedManagerActions[idx] ?? true))
        .map((title) => ({ title: title.trim(), owner: '部長' as ActionOwner }));

      const memberItemsToSave = finalSummary.memberActions
        .filter((text, idx) => text.trim() && (selectedMemberActions[idx] ?? true))
        .map((title) => ({ title: title.trim(), owner: '部員' as ActionOwner }));

      const allItemsToSave = [...managerItemsToSave, ...memberItemsToSave];

      if (allItemsToSave.length > 0) {
        await Promise.all(
          allItemsToSave.map((item) =>
            addDoc(collection(db, 'oneOnOneActions'), {
              logId: logRef.id,
              meetingDate,
              title: item.title,
              detail: `${meetingDate} の1on1（${target.name}）より抽出：${finalSummary.direction}`,
              status: '未着手',
              priority: defaultPriority,
              owner: item.owner,
              memberName: target.name,
              memberEmail: target.email,
              department: target.department,
              managerName,
              managerEmail,
              history: [
                {
                  id: `${Date.now()}_init`,
                  type: 'comment',
                  text: `1on1記録から${item.owner}向けネクストアクションを登録しました`,
                  actorName: managerName,
                  createdAtLabel: getNowFullLabel(),
                },
              ],
              createdAt: serverTimestamp(),
            })
          )
        );
      }

      setRawMemo('');
      setPrivateMemo('');
      setTranscript('');
      setDocUrl('');
      setSummaryDraft(null);
      setSelectedManagerActions([]);
      setSelectedMemberActions([]);

      alert(
        `✅ ${target.name}さんの1on1ログを保存しました！\n` +
          `🔒 部長用アクション ${managerItemsToSave.length}件 ／ 対象者用アクション ${memberItemsToSave.length}件をそれぞれの専用ボードへ分離登録しました。`
      );
      setActiveTab('overview');
    } catch {
      alert('保存に失敗しました。Firestoreの設定を確認してください。');
    } finally {
      setIsSavingLog(false);
    }
  };

  // 課題ボード操作
  const handleChangeActionStatus = async (item: ActionItem, nextStatus: ActionStatus) => {
    if (item.status === nextStatus) return;
    const actor = user?.displayName || '担当者';
    const entry: ActionHistoryItem = {
      id: `${Date.now()}_st`,
      type: 'status',
      text: `ステータスを「${item.status}」から「${nextStatus}」に変更しました`,
      actorName: actor,
      createdAtLabel: getNowFullLabel(),
    };
    await updateDoc(doc(db, 'oneOnOneActions', item.id), {
      status: nextStatus,
      history: arrayUnion(entry),
    });
  };

  const handleChangeActionPriority = async (item: ActionItem, nextPriority: ActionPriority) => {
    if (item.priority === nextPriority) return;
    const actor = user?.displayName || '担当者';
    const entry: ActionHistoryItem = {
      id: `${Date.now()}_pr`,
      type: 'priority',
      text: `優先度を「${item.priority}」から「${nextPriority}」に変更しました`,
      actorName: actor,
      createdAtLabel: getNowFullLabel(),
    };
    await updateDoc(doc(db, 'oneOnOneActions', item.id), {
      priority: nextPriority,
      history: arrayUnion(entry),
    });
  };

  const handleAddActionComment = async (item: ActionItem) => {
    const text = modalCommentText.trim();
    if (!text || isPostingComment) return;
    setIsPostingComment(true);
    try {
      const entry: ActionHistoryItem = {
        id: `${Date.now()}_cm`,
        type: 'comment',
        text,
        actorName: user?.displayName || '担当者',
        createdAtLabel: getNowFullLabel(),
      };
      await updateDoc(doc(db, 'oneOnOneActions', item.id), {
        history: arrayUnion(entry),
      });
      setModalCommentText('');
    } finally {
      setIsPostingComment(false);
    }
  };

  const handleDeleteLog = async (log: OneOnOneLog) => {
    if (!confirm(`${log.meetingDate} の「${log.memberName}」の1on1ログを削除しますか？`)) return;
    await deleteDoc(doc(db, 'oneOnOneLogs', log.id));
    if (selectedLogId === log.id) setSelectedLogId(null);
  };

  const handleDeleteAction = async (item: ActionItem) => {
    if (!confirm(`課題「${item.title}」を削除しますか？`)) return;
    await deleteDoc(doc(db, 'oneOnOneActions', item.id));
    if (selectedActionId === item.id) setSelectedActionId(null);
  };

  // =========================================
  // 👥 部員マスタ追加・編集・スプレッドシート一括取り込み
  // =========================================
  const handleAddMember = async () => {
    if (!newMemberName.trim() || !newMemberEmail.trim() || !newMemberDept.trim()) {
      alert('氏名・メールアドレス・部署を入力してください。');
      return;
    }
    await addDoc(collection(db, 'members'), {
      name: newMemberName.trim(),
      email: newMemberEmail.trim().toLowerCase(),
      department: newMemberDept.trim(),
      role: newMemberRole,
      managerEmail: (user?.email || '').toLowerCase(),
    });
    setNewMemberName('');
    setNewMemberEmail('');
    setNewMemberDept('');
  };

  const startEditMember = (m: Member) => {
    setEditingMemberId(m.id);
    setEditMemberForm({
      name: m.name,
      email: m.email,
      department: m.department,
      role: m.role,
    });
  };

  const handleSaveEditMember = async (memberId: string) => {
    if (
      !editMemberForm.name.trim() ||
      !editMemberForm.email.trim() ||
      !editMemberForm.department.trim()
    ) {
      alert('氏名・メールアドレス・部署は必須です。');
      return;
    }
    await updateDoc(doc(db, 'members', memberId), {
      name: editMemberForm.name.trim(),
      email: editMemberForm.email.trim().toLowerCase(),
      department: editMemberForm.department.trim(),
      role: editMemberForm.role,
    });
    setEditingMemberId(null);
  };

  const handleBulkImportMembers = async () => {
    const lines = bulkPasteText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return;

    setIsBulkImporting(true);
    try {
      const existingEmails = new Set(members.map((m) => m.email.toLowerCase()));
      let addedCount = 0;

      for (const line of lines) {
        const cols = line.split(/[\t,]+/).map((c) => c.trim()).filter(Boolean);
        const emailCol = cols.find((c) => c.includes('@'));
        if (!emailCol) continue;
        const email = emailCol.toLowerCase();
        if (existingEmails.has(email)) continue;

        // 数字だけのID列（例: 2, 7, 1001など）は自動でスキップ
        const nonEmailCols = cols.filter((c) => c !== emailCol && !/^\d+$/.test(c));
        const name = nonEmailCols[0] || email.split('@')[0];
        const department = nonEmailCols[1] || '未分類';
        const role: MemberRole = nonEmailCols.some((c) => c.includes('部長')) ? '部長' : '部員';

        await addDoc(collection(db, 'members'), {
          name,
          email,
          department,
          role,
          managerEmail: (user?.email || '').toLowerCase(),
        });
        existingEmails.add(email);
        addedCount++;
      }

      setBulkPasteText('');
      alert(`✅ ${addedCount}名の部員データを一括登録しました！`);
    } catch {
      alert('一括取り込み中にエラーが発生しました。');
    } finally {
      setIsBulkImporting(false);
    }
  };

  if (!user) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-emerald-950 to-teal-950 flex items-center justify-center p-6 text-left">
        <div className="bg-white/95 backdrop-blur-md p-10 rounded-3xl shadow-2xl border border-white/20 max-w-md w-full text-center">
          <div className="w-16 h-16 bg-gradient-to-tr from-emerald-600 to-teal-500 rounded-2xl mx-auto mb-6 flex items-center justify-center shadow-lg shadow-emerald-500/30 text-3xl">
            🤝
          </div>
          <h1 className="text-3xl font-black tracking-tight text-slate-900 mb-2">
            1on1 Log AI
          </h1>
          <p className="text-slate-500 text-sm mb-8 leading-relaxed">
            リアルタイム文字起こし＆AI要約で1on1を資産に。<br />
            記録した部長と本人だけのセキュアな面談管理
          </p>
          <button
            onClick={handleLogin}
            className="w-full bg-slate-900 hover:bg-slate-800 text-white font-bold py-3.5 px-6 rounded-xl shadow-lg transition-all active:scale-95 flex items-center justify-center gap-3"
          >
            <span className="bg-white text-slate-900 w-6 h-6 rounded-full flex items-center justify-center font-black text-xs">
              G
            </span>
            Googleアカウントでログイン
          </button>
        </div>
      </div>
    );
  }

  const userEmail = (user.email || '').toLowerCase();

  // ★1on1ログ閲覧制御：記録した部長 または 対象部員本人 のみ
  const visibleLogs = logs.filter(
    (l) =>
      l.managerEmail.toLowerCase() === userEmail || l.memberEmail.toLowerCase() === userEmail
  );

  // ★課題ボードの相互非公開制御：
  // 部長には owner==='部長' のみ、部員には owner==='部員' のみ表示（お互い非表示）
  // ※同一メールアドレスで動作テストしている場合のみ両方表示
  const visibleActions = actions.filter((a) => {
    const isManager = a.managerEmail.toLowerCase() === userEmail;
    const isMember = a.memberEmail.toLowerCase() === userEmail;
    if (!isManager && !isMember) return false;
    if (isManager && isMember) return true;
    if (a.owner === '両方') return true; // 過去データ互換
    if (isManager) return a.owner === '部長';
    if (isMember) return a.owner === '部員';
    return false;
  });

  const allDepartments = Array.from(
    new Set([...members.map((m) => m.department), ...visibleLogs.map((l) => l.department)])
  ).filter(Boolean);

  const monthLogs = visibleLogs.filter((l) => (l.meetingDate || '').startsWith(selectedMonth));
  const doneMemberEmailsThisMonth = new Set(monthLogs.map((l) => l.memberEmail.toLowerCase()));

  const filteredMembers = members.filter(
    (m) => overviewDeptFilter === 'すべて' || m.department === overviewDeptFilter
  );

  const filteredLogs = visibleLogs.filter((l) => {
    if (overviewDeptFilter !== 'すべて' && l.department !== overviewDeptFilter) return false;
    const q = overviewSearch.trim().toLowerCase();
    if (!q) return true;
    const hay = [
      l.memberName,
      l.department,
      l.rawMemo,
      l.aiSummary?.overview || '',
      l.aiSummary?.issues || '',
      l.aiSummary?.direction || '',
      l.transcript,
    ]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });

  const filteredBoardActions = visibleActions.filter((a) => {
    if (boardDeptFilter !== 'すべて' && a.department !== boardDeptFilter) return false;
    if (boardUrgentOnly && a.priority !== '急ぎ') return false;
    const q = boardSearch.trim().toLowerCase();
    if (!q) return true;
    const hay = [
      a.title,
      a.detail,
      a.memberName,
      a.department,
      ...(a.history || []).map((h) => h.text),
    ]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });

  const activeActionCount = visibleActions.filter((a) => a.status !== '完了').length;
  const highRiskCount = visibleLogs.filter((l) => l.aiSummary?.riskLevel === '高リスク').length;

  const selectedLog = visibleLogs.find((l) => l.id === selectedLogId) || null;
  const selectedAction = visibleActions.find((a) => a.id === selectedActionId) || null;

  const currentTargetName =
    members.find((m) => m.id === selectedMemberId)?.name || manualMemberName.trim() || '部員';

  const boardColumns: {
    key: ActionStatus;
    label: string;
    dot: string;
    badge: string;
    bg: string;
  }[] = [
    {
      key: '未着手',
      label: '未着手',
      dot: 'bg-blue-500',
      badge: 'bg-blue-100 text-blue-700',
      bg: 'bg-slate-100/80',
    },
    {
      key: '対応中',
      label: '対応中',
      dot: 'bg-amber-500',
      badge: 'bg-amber-100 text-amber-700',
      bg: 'bg-amber-50/40',
    },
    {
      key: '完了',
      label: '完了',
      dot: 'bg-emerald-500',
      badge: 'bg-emerald-100 text-emerald-700',
      bg: 'bg-emerald-50/40',
    },
  ];

  const riskBadgeStyle = (level?: RiskLevel) => {
    if (level === '高リスク') return 'bg-rose-100 text-rose-700 border-rose-200';
    if (level === '要注意') return 'bg-amber-100 text-amber-700 border-amber-200';
    return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  };

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-800 flex flex-col text-left">
      {/* ヘッダー */}
      <header className="bg-white/90 backdrop-blur-md border-b border-slate-200/80 px-4 md:px-8 py-3.5 flex flex-wrap items-center justify-between gap-4 sticky top-0 z-30">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 bg-gradient-to-tr from-emerald-600 to-teal-500 rounded-xl flex items-center justify-center text-white font-black shadow-sm">
            1
          </div>
          <div>
            <span className="text-lg font-black tracking-tight bg-gradient-to-r from-emerald-700 to-teal-600 bg-clip-text text-transparent block leading-none">
              1on1 Log AI
            </span>
            <span className="text-[10px] text-slate-400 font-bold">
              🔒 部長・本人限定ログ
            </span>
          </div>
        </div>

        <nav className="flex flex-wrap gap-1 bg-slate-100 p-1 rounded-xl">
          <button
            onClick={() => setActiveTab('overview')}
            className={`px-3.5 py-2 rounded-lg font-bold text-xs md:text-sm transition-all ${
              activeTab === 'overview'
                ? 'bg-white text-emerald-700 shadow-sm'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            📊 実施状況＆ログ
          </button>
          <button
            onClick={() => setActiveTab('record')}
            className={`px-3.5 py-2 rounded-lg font-bold text-xs md:text-sm transition-all ${
              activeTab === 'record'
                ? 'bg-white text-emerald-700 shadow-sm'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            🎙️ 1on1を記録
          </button>
          <button
            onClick={() => setActiveTab('board')}
            className={`px-3.5 py-2 rounded-lg font-bold text-xs md:text-sm transition-all flex items-center gap-1.5 ${
              activeTab === 'board'
                ? 'bg-white text-emerald-700 shadow-sm'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            📋 自分の課題ボード
            {activeActionCount > 0 && (
              <span className="bg-emerald-600 text-white text-[10px] px-1.5 py-0.5 rounded-full">
                {activeActionCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('members')}
            className={`px-3.5 py-2 rounded-lg font-bold text-xs md:text-sm transition-all ${
              activeTab === 'members'
                ? 'bg-white text-emerald-700 shadow-sm'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            👥 部員マスタ
          </button>
        </nav>

        <div className="flex items-center gap-3">
          {user.photoURL ? (
            <img
              src={user.photoURL}
              alt=""
              className="w-8 h-8 rounded-full ring-2 ring-slate-100"
            />
          ) : (
            <div className="w-8 h-8 rounded-full bg-emerald-100 text-emerald-700 font-bold flex items-center justify-center text-xs">
              {user.displayName?.[0] || 'U'}
            </div>
          )}
          <div className="hidden sm:block text-left">
            <p className="text-xs font-bold text-slate-700 leading-tight">{user.displayName}</p>
            <p className="text-[10px] text-slate-400 leading-tight">{user.email}</p>
          </div>
          <button
            onClick={handleLogout}
            className="text-xs text-slate-400 hover:text-slate-600 border border-slate-200 px-2.5 py-1 rounded-lg"
          >
            ログアウト
          </button>
        </div>
      </header>

      <main className="flex-1 p-4 md:p-8 max-w-7xl w-full mx-auto">
        {/* =========================================
            【1】実施状況＆1on1ログ一覧
        ========================================= */}
        {activeTab === 'overview' && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-2xl font-black text-slate-900">実施状況＆1on1ログ</h2>
                <p className="text-xs md:text-sm text-slate-500">
                  あなた（{user.email}）が記録した面談、またはあなた自身の面談ログのみ表示されています
                </p>
              </div>
              <button
                onClick={() => setActiveTab('record')}
                className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs md:text-sm font-bold px-5 py-2.5 rounded-xl shadow-sm transition-all"
              >
                🎙️ 新しい1on1を記録する
              </button>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm">
                <span className="text-xs font-bold text-slate-400">対象月の実施数</span>
                <p className="text-3xl font-black text-emerald-600 mt-1">
                  {monthLogs.length}
                  <span className="text-xs font-normal text-slate-400 ml-1">件</span>
                </p>
              </div>
              <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm">
                <span className="text-xs font-bold text-slate-400">累計ログ（閲覧権限内）</span>
                <p className="text-3xl font-black text-slate-900 mt-1">
                  {visibleLogs.length}
                  <span className="text-xs font-normal text-slate-400 ml-1">件</span>
                </p>
              </div>
              <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm">
                <span className="text-xs font-bold text-slate-400">自分の未完了アクション</span>
                <p className="text-3xl font-black text-amber-500 mt-1">
                  {activeActionCount}
                  <span className="text-xs font-normal text-slate-400 ml-1">件</span>
                </p>
              </div>
              <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm">
                <span className="text-xs font-bold text-slate-400">高リスク・要フォロー</span>
                <p className="text-3xl font-black text-rose-600 mt-1">
                  {highRiskCount}
                  <span className="text-xs font-normal text-slate-400 ml-1">件</span>
                </p>
              </div>
            </div>

            {/* 月次実施チェック */}
            <div className="bg-white p-6 rounded-3xl border border-slate-200/80 shadow-sm space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <h3 className="font-bold text-slate-900">📅 月次1on1 実施チェック</h3>
                  <input
                    type="month"
                    value={selectedMonth}
                    onChange={(e) => setSelectedMonth(e.target.value)}
                    className="text-xs font-bold border border-slate-200 rounded-lg px-2.5 py-1.5 bg-slate-50 outline-none focus:border-emerald-500"
                  />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    onClick={() => setOverviewDeptFilter('すべて')}
                    className={`text-xs font-bold px-3 py-1 rounded-full ${
                      overviewDeptFilter === 'すべて'
                        ? 'bg-emerald-600 text-white'
                        : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    すべて
                  </button>
                  {allDepartments.map((d) => (
                    <button
                      key={d}
                      onClick={() => setOverviewDeptFilter(d)}
                      className={`text-xs font-bold px-3 py-1 rounded-full ${
                        overviewDeptFilter === d
                          ? 'bg-emerald-600 text-white'
                          : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </div>

              {filteredMembers.length === 0 ? (
                <div className="text-center py-6 bg-slate-50 rounded-2xl border border-dashed border-slate-200">
                  <p className="text-xs text-slate-500 mb-2">
                    まだ部員マスタが登録されていません。スプレッドシートから一括登録できます。
                  </p>
                  <button
                    onClick={() => setActiveTab('members')}
                    className="text-xs font-bold text-emerald-700 hover:underline"
                  >
                    👥 部員マスタを登録しに行く →
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {filteredMembers.map((m) => {
                    const isDone = doneMemberEmailsThisMonth.has(m.email.toLowerCase());
                    return (
                      <div
                        key={m.id}
                        className={`p-3.5 rounded-2xl border flex items-center justify-between gap-2 ${
                          isDone
                            ? 'bg-emerald-50/50 border-emerald-200'
                            : 'bg-white border-slate-200'
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="font-bold text-sm text-slate-900 truncate">
                              {m.name}
                            </span>
                            <span className="text-[10px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full shrink-0">
                              {m.department}
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-400 truncate">{m.email}</p>
                        </div>
                        {isDone ? (
                          <span className="text-[11px] font-bold bg-emerald-600 text-white px-2.5 py-1 rounded-lg shrink-0">
                            ✓ 実施済
                          </span>
                        ) : (
                          <button
                            onClick={() => {
                              setSelectedMemberId(m.id);
                              setActiveTab('record');
                            }}
                            className="text-[11px] font-bold bg-slate-900 hover:bg-emerald-600 text-white px-2.5 py-1 rounded-lg shrink-0 transition-colors"
                          >
                            記録する →
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 1on1ログ一覧 */}
            <div className="bg-white p-6 rounded-3xl border border-slate-200/80 shadow-sm space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="font-bold text-slate-900">
                  🗂️ 1on1ログ履歴（{filteredLogs.length}件）
                </h3>
                <div className="relative w-full sm:w-72">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs">
                    🔍
                  </span>
                  <input
                    type="text"
                    value={overviewSearch}
                    onChange={(e) => setOverviewSearch(e.target.value)}
                    placeholder="氏名・課題・キーワードで検索..."
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-8 pr-3 py-2 text-xs outline-none focus:bg-white focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
              </div>

              {filteredLogs.length === 0 ? (
                <div className="text-center py-14 border-2 border-dashed border-slate-100 rounded-2xl">
                  <p className="text-3xl mb-2">📝</p>
                  <p className="text-sm text-slate-500">まだ1on1ログがありません</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {filteredLogs.map((log) => {
                    const isManager = log.managerEmail.toLowerCase() === userEmail;
                    return (
                      <div
                        key={log.id}
                        onClick={() => setSelectedLogId(log.id)}
                        className="cursor-pointer p-5 rounded-2xl border border-slate-200/80 hover:border-emerald-300 hover:bg-emerald-50/10 transition-all space-y-2.5"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-black text-slate-900 text-base">
                              👤 {log.memberName}
                            </span>
                            <span className="text-xs font-bold bg-slate-100 text-slate-600 px-2.5 py-0.5 rounded-full">
                              {log.department}
                            </span>
                            <span
                              className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full border ${riskBadgeStyle(
                                log.aiSummary?.riskLevel
                              )}`}
                            >
                              {log.aiSummary?.riskLevel || '通常'}
                            </span>
                            {isManager && log.privateMemo && (
                              <span className="text-[10px] font-bold bg-slate-800 text-white px-2 py-0.5 rounded-full">
                                🔒 部長メモあり
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="text-xs font-bold text-slate-500">
                              面談日：{log.meetingDate}
                            </span>
                            {isManager && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDeleteLog(log);
                                }}
                                className="text-xs text-red-500 hover:bg-red-50 font-bold px-2 py-1 rounded-lg"
                              >
                                削除
                              </button>
                            )}
                          </div>
                        </div>

                        <p className="text-sm text-slate-700 leading-relaxed">
                          {log.aiSummary?.overview}
                        </p>
                        <div className="bg-slate-50 p-3 rounded-xl text-xs text-slate-600">
                          <strong className="text-slate-800">現状の課題：</strong>
                          {log.aiSummary?.issues}
                        </div>
                        <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1">
                          <span>面談担当：{log.managerName}</span>
                          <span className="text-emerald-700 font-bold">
                            詳細・文字起こしを見る →
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* =========================================
            【2】1on1記録（リアルタイム録音・話者切替 ＆ AI要約）
        ========================================= */}
        {activeTab === 'record' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
            {/* 左カラム：入力＆リアルタイム音声文字起こし */}
            <div className="bg-white p-6 rounded-3xl border border-slate-200/80 shadow-sm space-y-5">
              <div>
                <h2 className="text-xl font-black text-slate-900">🎙️ 1on1を記録する</h2>
                <p className="text-xs text-slate-500">
                  話者切替つきのリアルタイム録音、または会話ログ全文の貼り付けに対応しています
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-bold text-slate-600 block mb-1">面談日</label>
                  <input
                    type="date"
                    value={meetingDate}
                    onChange={(e) => setMeetingDate(e.target.value)}
                    className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-500"
                  />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-600 block mb-1">
                    対象部員（マスタから選択）
                  </label>
                  <select
                    value={selectedMemberId}
                    onChange={(e) => setSelectedMemberId(e.target.value)}
                    className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white outline-none focus:border-emerald-500"
                  >
                    <option value="">-- 直接入力する --</option>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}（{m.department}）
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {!selectedMemberId && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 bg-slate-50 p-3.5 rounded-2xl border border-slate-200/70">
                  <input
                    type="text"
                    placeholder="部員氏名（例：井上陽斗）"
                    value={manualMemberName}
                    onChange={(e) => setManualMemberName(e.target.value)}
                    className="bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs outline-none focus:border-emerald-500"
                  />
                  <input
                    type="email"
                    placeholder="部員メールアドレス"
                    value={manualMemberEmail}
                    onChange={(e) => setManualMemberEmail(e.target.value)}
                    className="bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs outline-none focus:border-emerald-500"
                  />
                  <input
                    type="text"
                    placeholder="部署名（例：営業部）"
                    value={manualDepartment}
                    onChange={(e) => setManualDepartment(e.target.value)}
                    className="bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs outline-none focus:border-emerald-500"
                  />
                </div>
              )}

              <div>
                <label className="text-xs font-bold text-slate-700 block mb-1">
                  ✏️ ざっくりメモ（要点・AI要約のヒント）
                </label>
                <textarea
                  rows={3}
                  placeholder="例：転職希望あり。現在の担当業務と強みが合っていないと感じている。強みを活かせる配置転換も検討。"
                  value={rawMemo}
                  onChange={(e) => setRawMemo(e.target.value)}
                  className="w-full border border-slate-200 rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              <div className="bg-slate-900/5 p-4 rounded-2xl border border-slate-200">
                <label className="text-xs font-bold text-slate-800 flex items-center gap-1.5 mb-1">
                  🔒 部長専用・非公開メモ（対象部員には表示されません）
                </label>
                <textarea
                  rows={2}
                  placeholder="例：何とか引き留めたい。来週中に人事部長へ配置転換の相談を入れる。"
                  value={privateMemo}
                  onChange={(e) => setPrivateMemo(e.target.value)}
                  className="w-full bg-white border border-slate-200 rounded-xl px-3.5 py-2.5 text-xs outline-none focus:border-slate-500"
                />
              </div>

              {/* リアルタイム音声文字起こし ＋ 話者切替コントロール */}
              <div className="space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="text-xs font-bold text-slate-700">
                    🗣️ 会話ログ全文（リアルタイム録音 ／ テキスト貼り付け）
                  </label>
                  {!isRecording ? (
                    <button
                      type="button"
                      onClick={handleStartRecording}
                      className="bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold px-3.5 py-1.5 rounded-xl shadow-sm flex items-center gap-1.5 transition-all active:scale-95"
                    >
                      🎙️ 録音して文字起こし開始
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleStopRecording}
                      className="bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold px-3.5 py-1.5 rounded-xl shadow-sm flex items-center gap-1.5 animate-pulse"
                    >
                      ⏹️ 録音を停止する
                    </button>
                  )}
                </div>

                {/* 話者切替バー */}
                <div className="bg-slate-50 border border-slate-200 rounded-2xl p-3 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[11px] font-bold text-slate-600">
                    録音時の発言者ラベル：
                  </span>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => setCurrentSpeaker('manager')}
                      className={`text-xs font-bold px-3 py-1.5 rounded-xl transition-all ${
                        currentSpeaker === 'manager'
                          ? 'bg-emerald-600 text-white shadow-xs'
                          : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      👔 {user.displayName || '部長'}（自分）
                    </button>
                    <button
                      type="button"
                      onClick={() => setCurrentSpeaker('member')}
                      className={`text-xs font-bold px-3 py-1.5 rounded-xl transition-all ${
                        currentSpeaker === 'member'
                          ? 'bg-blue-600 text-white shadow-xs'
                          : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      👤 {currentTargetName}
                    </button>
                  </div>
                </div>

                {isRecording && (
                  <div className="bg-rose-50 border border-rose-200 text-rose-800 text-xs p-3 rounded-xl flex items-center gap-2">
                    <span className="w-2.5 h-2.5 bg-rose-500 rounded-full animate-ping shrink-0" />
                    <span className="font-bold shrink-0">
                      [{currentSpeaker === 'manager' ? user.displayName || '部長' : currentTargetName}]
                    </span>
                    <span className="text-rose-600 truncate">
                      {interimText || '聞き取り中...（話者が変わったら上のボタンで切替）'}
                    </span>
                  </div>
                )}

                <textarea
                  rows={7}
                  placeholder={`録音すると「${currentTargetName}：〇〇〜」のように話者付きで文字起こしされます。\nGoogle Meet等の文字起こし全文をそのまま貼り付けることもできます。`}
                  value={transcript}
                  onChange={(e) => setTranscript(e.target.value)}
                  className="w-full border border-slate-200 rounded-2xl px-4 py-3 text-xs leading-relaxed outline-none focus:ring-2 focus:ring-emerald-500"
                />

                <input
                  type="url"
                  placeholder="元のGoogleドキュメントURL（任意・リンク保存用）"
                  value={docUrl}
                  onChange={(e) => setDocUrl(e.target.value)}
                  className="w-full border border-slate-200 rounded-xl px-3.5 py-2 text-xs outline-none focus:border-emerald-500"
                />
              </div>

              <button
                type="button"
                onClick={handleGenerateSummary}
                disabled={isSummarizing}
                className="w-full bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 disabled:opacity-50 text-white font-bold py-3.5 rounded-2xl shadow-md transition-all text-sm"
              >
                {isSummarizing
                  ? '🤖 要約とネクストアクションを作成中...'
                  : '✨ AIで面談内容・課題を自動要約する'}
              </button>
            </div>

            {/* 右カラム：AI出力プレビュー＆編集＆保存 */}
            <div className="bg-white p-6 rounded-3xl border border-slate-200/80 shadow-sm space-y-5">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-black text-slate-900">📄 AI要約・課題プレビュー</h3>
                  <p className="text-xs text-slate-500">
                    部長用・対象者用アクションは保存後お互い非公開になります
                  </p>
                </div>
                {summaryDraft && (
                  <select
                    value={summaryDraft.riskLevel}
                    onChange={(e) =>
                      setSummaryDraft({
                        ...summaryDraft,
                        riskLevel: e.target.value as RiskLevel,
                      })
                    }
                    className={`text-xs font-bold px-3 py-1.5 rounded-xl border outline-none ${riskBadgeStyle(
                      summaryDraft.riskLevel
                    )}`}
                  >
                    <option value="通常">通常</option>
                    <option value="要注意">要注意</option>
                    <option value="高リスク">高リスク</option>
                  </select>
                )}
              </div>

              {!summaryDraft ? (
                <div className="text-center py-20 border-2 border-dashed border-slate-200 rounded-2xl space-y-2">
                  <p className="text-4xl">🤖</p>
                  <p className="text-sm font-bold text-slate-600">
                    左側のメモや文字起こしを入力して要約ボタンを押してください
                  </p>
                  <p className="text-xs text-slate-400">
                    面談要約＋部長用・対象者用それぞれのネクストアクションが自動生成されます
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <label className="text-xs font-bold text-slate-500 block mb-1">面談概要</label>
                    <textarea
                      rows={2}
                      value={summaryDraft.overview}
                      onChange={(e) =>
                        setSummaryDraft({ ...summaryDraft, overview: e.target.value })
                      }
                      className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm outline-none focus:border-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-slate-500 block mb-1">
                      現状の課題
                    </label>
                    <textarea
                      rows={2}
                      value={summaryDraft.issues}
                      onChange={(e) =>
                        setSummaryDraft({ ...summaryDraft, issues: e.target.value })
                      }
                      className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm outline-none focus:border-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-slate-500 block mb-1">背景</label>
                    <textarea
                      rows={2}
                      value={summaryDraft.background}
                      onChange={(e) =>
                        setSummaryDraft({ ...summaryDraft, background: e.target.value })
                      }
                      className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm outline-none focus:border-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-slate-500 block mb-1">
                      解決に向けた方向性
                    </label>
                    <textarea
                      rows={3}
                      value={summaryDraft.direction}
                      onChange={(e) =>
                        setSummaryDraft({ ...summaryDraft, direction: e.target.value })
                      }
                      className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm outline-none focus:border-emerald-500"
                    />
                  </div>

                  {/* 部長用ネクストアクション（対象者には非公開） */}
                  <div className="bg-slate-900/5 p-4 rounded-2xl border border-slate-300/80 space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-slate-900">
                        🔒 部長（あなた）のネクストアクション（対象者には非公開）
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setSummaryDraft({
                            ...summaryDraft,
                            managerActions: [...summaryDraft.managerActions, ''],
                          });
                          setSelectedManagerActions((prev) => [...prev, true]);
                        }}
                        className="text-xs font-bold text-slate-700 hover:underline shrink-0"
                      >
                        ＋ 追加
                      </button>
                    </div>
                    {summaryDraft.managerActions.map((act, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selectedManagerActions[idx] ?? true}
                          onChange={(e) =>
                            setSelectedManagerActions((prev) =>
                              prev.map((v, i) => (i === idx ? e.target.checked : v))
                            )
                          }
                          className="w-4 h-4 accent-slate-800"
                        />
                        <input
                          type="text"
                          value={act}
                          onChange={(e) => {
                            const next = [...summaryDraft.managerActions];
                            next[idx] = e.target.value;
                            setSummaryDraft({ ...summaryDraft, managerActions: next });
                          }}
                          className="flex-1 bg-white border border-slate-200 rounded-xl px-3 py-1.5 text-xs outline-none focus:border-slate-500"
                        />
                      </div>
                    ))}
                  </div>

                  {/* 対象部員用ネクストアクション（保存後は部員専用ボードのみ表示） */}
                  <div className="bg-blue-50/60 p-4 rounded-2xl border border-blue-200/80 space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-blue-900">
                        👤 対象者（{currentTargetName}）のネクストアクション（保存後は本人のみ閲覧）
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setSummaryDraft({
                            ...summaryDraft,
                            memberActions: [...summaryDraft.memberActions, ''],
                          });
                          setSelectedMemberActions((prev) => [...prev, true]);
                        }}
                        className="text-xs font-bold text-blue-700 hover:underline shrink-0"
                      >
                        ＋ 追加
                      </button>
                    </div>
                    {summaryDraft.memberActions.map((act, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selectedMemberActions[idx] ?? true}
                          onChange={(e) =>
                            setSelectedMemberActions((prev) =>
                              prev.map((v, i) => (i === idx ? e.target.checked : v))
                            )
                          }
                          className="w-4 h-4 accent-blue-600"
                        />
                        <input
                          type="text"
                          value={act}
                          onChange={(e) => {
                            const next = [...summaryDraft.memberActions];
                            next[idx] = e.target.value;
                            setSummaryDraft({ ...summaryDraft, memberActions: next });
                          }}
                          className="flex-1 bg-white border border-blue-200 rounded-xl px-3 py-1.5 text-xs outline-none focus:border-blue-500"
                        />
                      </div>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={handleSaveOneOnOne}
                    disabled={isSavingLog}
                    className="w-full bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 text-white font-bold py-3.5 rounded-2xl shadow-md text-sm transition-all"
                  >
                    {isSavingLog
                      ? '保存中...'
                      : '💾 1on1ログを保存＆それぞれの専用ボードへ登録する'}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* =========================================
            【3】自分の課題・アクションボード（相互非公開）
        ========================================= */}
        {activeTab === 'board' && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-2xl font-black text-slate-900">📋 自分の課題ボード</h2>
                <p className="text-xs text-slate-500">
                  🔒 あなた（{user.email}）宛てのネクストアクションのみ表示されます（相手のボードには見えません）
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative w-60">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs">
                    🔍
                  </span>
                  <input
                    type="text"
                    value={boardSearch}
                    onChange={(e) => setBoardSearch(e.target.value)}
                    placeholder="課題・部員名で検索..."
                    className="w-full bg-white border border-slate-200 rounded-xl pl-8 pr-3 py-2 text-xs outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
                <button
                  onClick={() => setBoardUrgentOnly((prev) => !prev)}
                  className={`text-xs font-bold px-3.5 py-2 rounded-xl border ${
                    boardUrgentOnly
                      ? 'bg-rose-600 text-white border-rose-600'
                      : 'bg-white text-rose-600 border-rose-200'
                  }`}
                >
                  🔥 急ぎのみ
                </button>
              </div>
            </div>

            {allDepartments.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  onClick={() => setBoardDeptFilter('すべて')}
                  className={`text-xs font-bold px-3 py-1.5 rounded-full ${
                    boardDeptFilter === 'すべて'
                      ? 'bg-emerald-600 text-white'
                      : 'bg-white text-slate-600 border border-slate-200'
                  }`}
                >
                  すべて
                </button>
                {allDepartments.map((d) => (
                  <button
                    key={d}
                    onClick={() => setBoardDeptFilter(d)}
                    className={`text-xs font-bold px-3 py-1.5 rounded-full ${
                      boardDeptFilter === d
                        ? 'bg-emerald-600 text-white'
                        : 'bg-white text-slate-600 border border-slate-200'
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {boardColumns.map((col) => {
                const colItems = filteredBoardActions
                  .filter((a) => a.status === col.key)
                  .sort((a, b) => Number(b.priority === '急ぎ') - Number(a.priority === '急ぎ'));
                return (
                  <div
                    key={col.key}
                    className={`${col.bg} rounded-3xl p-4 border border-slate-200/80 min-h-[540px]`}
                  >
                    <div className="flex items-center justify-between mb-4 px-1">
                      <h3 className="font-bold text-slate-800 flex items-center gap-2">
                        <span className={`w-2.5 h-2.5 rounded-full ${col.dot}`} />
                        {col.label}
                      </h3>
                      <span className={`${col.badge} text-xs font-bold px-2.5 py-0.5 rounded-full`}>
                        {colItems.length}件
                      </span>
                    </div>

                    <div className="space-y-3">
                      {colItems.length === 0 ? (
                        <div className="h-24 border-2 border-dashed border-slate-200 rounded-2xl flex items-center justify-center text-xs text-slate-400">
                          課題はありません
                        </div>
                      ) : (
                        colItems.map((item) => (
                          <div
                            key={item.id}
                            onClick={() => {
                              setSelectedActionId(item.id);
                              setModalCommentText('');
                            }}
                            className={`cursor-pointer bg-white p-4 rounded-2xl shadow-sm border transition-all hover:shadow-md hover:border-emerald-300 ${
                              col.key === '完了'
                                ? 'opacity-75 border-slate-200'
                                : item.priority === '急ぎ'
                                ? 'border-rose-300 ring-1 ring-rose-100'
                                : 'border-slate-200'
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2 mb-2">
                              <div className="flex flex-wrap gap-1.5">
                                {item.priority === '急ぎ' && (
                                  <span className="bg-rose-100 text-rose-700 text-[10px] font-extrabold px-2 py-0.5 rounded-full">
                                    🔥 急ぎ
                                  </span>
                                )}
                                <span
                                  className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                                    item.owner === '部長'
                                      ? 'bg-slate-800 text-white'
                                      : 'bg-blue-100 text-blue-700'
                                  }`}
                                >
                                  🔒 {item.owner}用
                                </span>
                                <span className="bg-emerald-50 text-emerald-700 text-[11px] font-bold px-2 py-0.5 rounded-full">
                                  👤 {item.memberName}
                                </span>
                              </div>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDeleteAction(item);
                                }}
                                className="text-[11px] text-red-400 hover:text-red-600 px-1"
                              >
                                ✕
                              </button>
                            </div>

                            <h4
                              className={`font-bold text-sm text-slate-900 mb-1.5 ${
                                col.key === '完了' ? 'line-through text-slate-500' : ''
                              }`}
                            >
                              {item.title}
                            </h4>
                            <p className="text-xs text-slate-500 leading-relaxed mb-3">
                              {item.detail}
                            </p>

                            <div
                              onClick={(e) => e.stopPropagation()}
                              className="flex items-center justify-between pt-2.5 border-t border-slate-100"
                            >
                              <span className="text-[11px] text-slate-400">
                                💬 {item.history?.length || 0}件
                              </span>
                              <div className="flex gap-1.5">
                                {col.key !== '未着手' && (
                                  <button
                                    onClick={() =>
                                      handleChangeActionStatus(
                                        item,
                                        col.key === '完了' ? '対応中' : '未着手'
                                      )
                                    }
                                    className="text-xs text-slate-400 hover:text-slate-700 px-2 py-1"
                                  >
                                    ← 戻す
                                  </button>
                                )}
                                {col.key !== '完了' && (
                                  <button
                                    onClick={() =>
                                      handleChangeActionStatus(
                                        item,
                                        col.key === '未着手' ? '対応中' : '完了'
                                      )
                                    }
                                    className={`text-xs font-bold text-white px-3 py-1 rounded-lg ${
                                      col.key === '未着手'
                                        ? 'bg-emerald-600 hover:bg-emerald-700'
                                        : 'bg-slate-900 hover:bg-slate-800'
                                    }`}
                                  >
                                    {col.key === '未着手' ? '対応中へ →' : '完了 ✓'}
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* =========================================
            【4】部員マスタ管理（編集対応 ＆ 一括取り込み）
        ========================================= */}
        {activeTab === 'members' && (
          <div className="max-w-5xl space-y-6">
            <div className="bg-white p-6 rounded-3xl border border-emerald-200/80 shadow-sm space-y-3">
              <h3 className="font-bold text-base text-slate-900">
                📥 スプレッドシートから一括取り込み
              </h3>
              <p className="text-xs text-slate-500">
                スプレッドシートの「氏名・メールアドレス・部署・役職」の行をそのままコピー＆ペーストしてください（先頭に数字だけの番号列があっても自動でスキップします）。
              </p>
              <textarea
                rows={4}
                placeholder={`例：\n井上陽斗\tinoue@company.co.jp\t営業部\t部員\n武田太郎\ttakeda@company.co.jp\t開発部\t部員`}
                value={bulkPasteText}
                onChange={(e) => setBulkPasteText(e.target.value)}
                className="w-full border border-slate-200 rounded-2xl px-4 py-3 text-xs font-mono outline-none focus:ring-2 focus:ring-emerald-500"
              />
              <button
                onClick={handleBulkImportMembers}
                disabled={isBulkImporting || !bulkPasteText.trim()}
                className="bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white font-bold px-5 py-2.5 rounded-xl text-xs shadow-sm"
              >
                {isBulkImporting ? '取り込み中...' : '✓ 貼り付けた部員を一括登録する'}
              </button>
            </div>

            <div className="bg-white p-6 rounded-3xl border border-slate-200/80 shadow-sm space-y-4">
              <h3 className="font-bold text-base text-slate-900">👤 部員を1名追加</h3>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <input
                  type="text"
                  placeholder="氏名（例：井上陽斗）"
                  value={newMemberName}
                  onChange={(e) => setNewMemberName(e.target.value)}
                  className="border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm outline-none focus:border-emerald-500"
                />
                <input
                  type="email"
                  placeholder="メールアドレス"
                  value={newMemberEmail}
                  onChange={(e) => setNewMemberEmail(e.target.value)}
                  className="border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm outline-none focus:border-emerald-500"
                />
                <input
                  type="text"
                  placeholder="部署名"
                  value={newMemberDept}
                  onChange={(e) => setNewMemberDept(e.target.value)}
                  className="border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm outline-none focus:border-emerald-500"
                />
                <select
                  value={newMemberRole}
                  onChange={(e) => setNewMemberRole(e.target.value as MemberRole)}
                  className="border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm bg-white outline-none focus:border-emerald-500"
                >
                  <option value="部員">部員</option>
                  <option value="部長">部長</option>
                </select>
              </div>
              <button
                onClick={handleAddMember}
                className="bg-slate-900 hover:bg-slate-800 text-white font-bold px-5 py-2.5 rounded-xl text-xs"
              >
                ＋ 部員を追加
              </button>

              <div className="pt-4 border-t border-slate-100">
                <h4 className="font-bold text-sm text-slate-800 mb-3">
                  登録済み部員マスタ（{members.length}名）
                </h4>
                <div className="divide-y divide-slate-100 border border-slate-200/80 rounded-2xl overflow-hidden">
                  {members.length === 0 ? (
                    <p className="text-xs text-slate-400 text-center py-8">
                      まだ登録されていません
                    </p>
                  ) : (
                    members.map((m) => {
                      const isEditing = editingMemberId === m.id;
                      if (isEditing) {
                        return (
                          <div
                            key={m.id}
                            className="p-4 bg-emerald-50/40 space-y-2.5"
                          >
                            <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                              <input
                                type="text"
                                placeholder="氏名"
                                value={editMemberForm.name}
                                onChange={(e) =>
                                  setEditMemberForm({ ...editMemberForm, name: e.target.value })
                                }
                                className="bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-xs outline-none focus:border-emerald-500"
                              />
                              <input
                                type="email"
                                placeholder="メールアドレス"
                                value={editMemberForm.email}
                                onChange={(e) =>
                                  setEditMemberForm({ ...editMemberForm, email: e.target.value })
                                }
                                className="bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-xs outline-none focus:border-emerald-500"
                              />
                              <input
                                type="text"
                                placeholder="部署名"
                                value={editMemberForm.department}
                                onChange={(e) =>
                                  setEditMemberForm({
                                    ...editMemberForm,
                                    department: e.target.value,
                                  })
                                }
                                className="bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-xs outline-none focus:border-emerald-500"
                              />
                              <select
                                value={editMemberForm.role}
                                onChange={(e) =>
                                  setEditMemberForm({
                                    ...editMemberForm,
                                    role: e.target.value as MemberRole,
                                  })
                                }
                                className="bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-xs outline-none focus:border-emerald-500"
                              >
                                <option value="部員">部員</option>
                                <option value="部長">部長</option>
                              </select>
                            </div>
                            <div className="flex justify-end gap-2">
                              <button
                                onClick={() => setEditingMemberId(null)}
                                className="text-xs font-bold text-slate-500 bg-white border border-slate-200 px-3 py-1.5 rounded-lg"
                              >
                                キャンセル
                              </button>
                              <button
                                onClick={() => handleSaveEditMember(m.id)}
                                className="text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 px-4 py-1.5 rounded-lg"
                              >
                                保存する
                              </button>
                            </div>
                          </div>
                        );
                      }

                      return (
                        <div
                          key={m.id}
                          className="px-4 py-3 bg-white flex flex-wrap items-center justify-between gap-2 text-xs"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-bold text-slate-900">{m.name}</span>
                            <span className="bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full font-bold">
                              {m.department}
                            </span>
                            <span className="bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full font-bold">
                              {m.role}
                            </span>
                            <span className="text-slate-500">{m.email}</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => startEditMember(m)}
                              className="text-emerald-700 hover:bg-emerald-50 font-bold px-2.5 py-1 rounded-lg border border-emerald-200"
                            >
                              編集
                            </button>
                            <button
                              onClick={async () => {
                                if (confirm(`${m.name}さんをマスタから削除しますか？`)) {
                                  await deleteDoc(doc(db, 'members', m.id));
                                }
                              }}
                              className="text-red-500 hover:bg-red-50 font-bold px-2.5 py-1 rounded-lg"
                            >
                              削除
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* =========================================
          【モーダル1】1on1ログ詳細（話者色分け ＆ 相互非公開アクション）
      ========================================= */}
      {selectedLog && (() => {
        const isManagerViewer = selectedLog.managerEmail.toLowerCase() === userEmail;
        const isMemberViewer = selectedLog.memberEmail.toLowerCase() === userEmail;
        const managerList =
          selectedLog.aiSummary?.managerActions ?? selectedLog.aiSummary?.nextActions ?? [];
        const memberList = selectedLog.aiSummary?.memberActions ?? [];

        return (
          <div
            onClick={() => setSelectedLogId(null)}
            className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs z-50 flex items-center justify-center p-4 text-left"
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="bg-white rounded-3xl shadow-2xl border border-slate-200 max-w-2xl w-full max-h-[88vh] flex flex-col overflow-hidden"
            >
              <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex items-start justify-between gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <span className="text-xs font-bold bg-slate-200 text-slate-700 px-2.5 py-0.5 rounded-full">
                      {selectedLog.meetingDate}
                    </span>
                    <span className="text-xs font-bold bg-emerald-50 text-emerald-700 px-2.5 py-0.5 rounded-full">
                      {selectedLog.department}
                    </span>
                    <span
                      className={`text-xs font-bold px-2.5 py-0.5 rounded-full border ${riskBadgeStyle(
                        selectedLog.aiSummary?.riskLevel
                      )}`}
                    >
                      {selectedLog.aiSummary?.riskLevel || '通常'}
                    </span>
                  </div>
                  <h3 className="text-lg font-black text-slate-900">
                    👤 {selectedLog.memberName} さんの1on1記録
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    閲覧可能：{selectedLog.managerName}（{selectedLog.managerEmail}）＆{' '}
                    {selectedLog.memberName}（{selectedLog.memberEmail}）
                  </p>
                </div>
                <button
                  onClick={() => setSelectedLogId(null)}
                  className="w-8 h-8 rounded-full bg-white border border-slate-200 text-slate-500 font-bold shrink-0"
                >
                  ✕
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-6 space-y-5 text-sm">
                {/* 部長専用非公開メモ */}
                {isManagerViewer && selectedLog.privateMemo && (
                  <div className="bg-slate-900 text-white p-4 rounded-2xl space-y-1">
                    <span className="text-[11px] font-bold text-amber-300 block">
                      🔒 部長専用メモ（あなたにだけ表示されています）
                    </span>
                    <p className="text-xs leading-relaxed whitespace-pre-wrap">
                      {selectedLog.privateMemo}
                    </p>
                  </div>
                )}

                <div className="space-y-3 bg-emerald-50/40 p-4 rounded-2xl border border-emerald-100">
                  <h4 className="font-bold text-emerald-900 text-xs">🤖 AI要約：面談内容</h4>
                  <p className="text-slate-800 leading-relaxed">
                    {selectedLog.aiSummary?.overview}
                  </p>
                  <div className="text-xs space-y-2 text-slate-700 pt-2 border-t border-emerald-100">
                    <p>
                      <strong>・現状の課題：</strong>
                      {selectedLog.aiSummary?.issues}
                    </p>
                    <p>
                      <strong>・背景：</strong>
                      {selectedLog.aiSummary?.background}
                    </p>
                    <p>
                      <strong>・解決に向けた方向性：</strong>
                      {selectedLog.aiSummary?.direction}
                    </p>
                  </div>
                </div>

                {/* 部長のネクストアクション（部長にだけ表示） */}
                {isManagerViewer && managerList.length > 0 && (
                  <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-1.5">
                    <h4 className="font-bold text-slate-900 text-xs">
                      🔒 あなた（部長）のネクストアクション（対象者には非公開）
                    </h4>
                    <ul className="list-disc pl-5 text-xs text-slate-700 space-y-1">
                      {managerList.map((a, i) => (
                        <li key={i}>{a}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* 対象者のネクストアクション（対象者本人にだけ表示） */}
                {isMemberViewer && memberList.length > 0 && (
                  <div className="bg-blue-50/60 border border-blue-200 rounded-2xl p-4 space-y-1.5">
                    <h4 className="font-bold text-blue-900 text-xs">
                      🔒 あなたのネクストアクション（部長側のボードには非公開）
                    </h4>
                    <ul className="list-disc pl-5 text-xs text-slate-700 space-y-1">
                      {memberList.map((a, i) => (
                        <li key={i}>{a}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {selectedLog.docUrl && (
                  <div className="text-xs">
                    <span className="font-bold text-slate-600">元ドキュメント：</span>
                    <a
                      href={selectedLog.docUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-emerald-700 underline break-all"
                    >
                      {selectedLog.docUrl}
                    </a>
                  </div>
                )}

                {/* 会話ログ全文（話者ごとにラベル色分け） */}
                {selectedLog.transcript && (
                  <div className="space-y-2">
                    <h4 className="font-bold text-slate-800 text-xs">🗣️ 会話ログ全文</h4>
                    <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-2 max-h-72 overflow-y-auto">
                      {selectedLog.transcript
                        .split(/\r?\n/)
                        .filter((line) => line.trim())
                        .map((line, idx) => {
                          const parsed = parseTranscriptLine(
                            line,
                            selectedLog.managerName,
                            selectedLog.memberName
                          );
                          return (
                            <div key={idx} className="text-xs leading-relaxed flex items-start gap-2">
                              {parsed.speaker && (
                                <span
                                  className={`font-bold px-2 py-0.5 rounded-md shrink-0 text-[10px] ${
                                    parsed.role === 'manager'
                                      ? 'bg-emerald-100 text-emerald-800'
                                      : parsed.role === 'member'
                                      ? 'bg-blue-100 text-blue-800'
                                      : 'bg-slate-200 text-slate-700'
                                  }`}
                                >
                                  {parsed.speaker}
                                </span>
                              )}
                              <span className="text-slate-700">{parsed.body}</span>
                            </div>
                          );
                        })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* =========================================
          【モーダル2】課題詳細・コメント履歴モーダル
      ========================================= */}
      {selectedAction && (
        <div
          onClick={() => setSelectedActionId(null)}
          className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs z-50 flex items-center justify-center p-4 text-left"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white rounded-3xl shadow-2xl border border-slate-200 max-w-xl w-full max-h-[86vh] flex flex-col overflow-hidden"
          >
            <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex items-start justify-between gap-4">
              <div>
                <div className="flex flex-wrap items-center gap-1.5 mb-1">
                  <span
                    className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
                      selectedAction.owner === '部長'
                        ? 'bg-slate-800 text-white'
                        : 'bg-blue-100 text-blue-700'
                    }`}
                  >
                    🔒 {selectedAction.owner}専用
                  </span>
                  <span className="text-xs font-bold bg-emerald-50 text-emerald-700 px-2.5 py-0.5 rounded-full">
                    👤 {selectedAction.memberName}（{selectedAction.department}）
                  </span>
                  <span className="text-xs text-slate-400">
                    {formatTimestamp(selectedAction.createdAt)}
                  </span>
                </div>
                <h3 className="text-base font-black text-slate-900">{selectedAction.title}</h3>
              </div>
              <button
                onClick={() => setSelectedActionId(null)}
                className="w-8 h-8 rounded-full bg-white border border-slate-200 text-slate-500 font-bold shrink-0"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              <p className="text-xs text-slate-600 bg-slate-50 p-3.5 rounded-2xl border border-slate-200/70">
                {selectedAction.detail}
              </p>

              <div className="grid grid-cols-2 gap-3">
                <div className="border border-slate-200 rounded-2xl p-3 space-y-1.5">
                  <span className="text-[11px] font-bold text-slate-500 block">ステータス</span>
                  <div className="flex flex-wrap gap-1">
                    {(['未着手', '対応中', '完了'] as const).map((st) => (
                      <button
                        key={st}
                        onClick={() => handleChangeActionStatus(selectedAction, st)}
                        className={`text-xs font-bold px-2.5 py-1 rounded-lg ${
                          selectedAction.status === st
                            ? 'bg-slate-900 text-white'
                            : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {st}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="border border-slate-200 rounded-2xl p-3 space-y-1.5">
                  <span className="text-[11px] font-bold text-slate-500 block">優先度</span>
                  <div className="flex gap-1">
                    {(['通常', '急ぎ'] as const).map((p) => (
                      <button
                        key={p}
                        onClick={() => handleChangeActionPriority(selectedAction, p)}
                        className={`text-xs font-bold px-3 py-1 rounded-lg ${
                          selectedAction.priority === p
                            ? p === '急ぎ'
                              ? 'bg-rose-600 text-white'
                              : 'bg-slate-900 text-white'
                            : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {p === '急ぎ' ? '🔥 急ぎ' : '通常'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <h4 className="text-xs font-bold text-slate-700">
                  🕒 フォロー履歴（{selectedAction.history?.length || 0}件）
                </h4>
                {(selectedAction.history || []).map((h) => (
                  <div
                    key={h.id}
                    className="p-3 rounded-xl border border-slate-200/80 bg-white text-xs"
                  >
                    <div className="flex justify-between text-[10px] text-slate-400 mb-1">
                      <span className="font-bold text-slate-700">{h.actorName}</span>
                      <span>{h.createdAtLabel}</span>
                    </div>
                    <p className="text-slate-700 whitespace-pre-wrap">{h.text}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="p-4 bg-slate-50 border-t border-slate-200 flex gap-2">
              <input
                type="text"
                placeholder="進捗メモやコメントを追加..."
                value={modalCommentText}
                onChange={(e) => setModalCommentText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    handleAddActionComment(selectedAction);
                  }
                }}
                className="flex-1 bg-white border border-slate-200 rounded-xl px-3.5 py-2 text-xs outline-none focus:ring-2 focus:ring-emerald-500"
              />
              <button
                onClick={() => handleAddActionComment(selectedAction)}
                disabled={isPostingComment || !modalCommentText.trim()}
                className="bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white font-bold px-4 py-2 rounded-xl text-xs"
              >
                投稿
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
