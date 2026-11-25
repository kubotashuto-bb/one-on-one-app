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

type TaskPriority = '通常' | '急ぎ';

interface FirestoreTimestamp {
  toDate?: () => Date;
}

interface TaskHistoryItem {
  id: string;
  type: 'comment' | 'status' | 'transfer' | 'priority';
  text: string;
  actorName: string;
  actorEmail?: string;
  statusTo?: '未処理' | '対応中' | '完了';
  createdAtLabel: string;
}

interface Task {
  id: string;
  title: string;
  category: string;
  detail: string;
  status: '未処理' | '対応中' | '完了';
  priority?: TaskPriority;
  recommendedDept?: string;
  recommendedDepts?: string[];
  aiReason?: string;
  tags?: string[];
  createdBy?: string;
  creatorName?: string;
  creatorEmail?: string;
  creatorPhoto?: string;
  adminComment?: string;
  history?: TaskHistoryItem[];
  createdAt?: FirestoreTimestamp | null;
}

interface Department {
  id: string;
  name: string;
  expertise: string;
  managerEmail?: string;
}

interface Proposal {
  department: string;
  departments: string[];
  title: string;
  detail: string;
  reason: string;
  tags: string[];
  priority?: TaskPriority;
}

interface ChatMessage {
  role: 'user' | 'ai';
  text: string;
  time: string;
  proposal?: Proposal;
  isSubmitted?: boolean;
  isError?: boolean;
}

interface AppNotification {
  id: string;
  targetUid?: string;
  targetEmail?: string;
  kind?: 'new_task' | 'status_update';
  taskId: string;
  taskTitle: string;
  department: string;
  newStatus: '未処理' | '対応中' | '完了';
  comment?: string;
  actorName: string;
  read: boolean;
  createdAt?: FirestoreTimestamp | null;
}

const QUICK_PROMPTS = [
  '💻 PCやVPNの調子が悪い',
  '📄 契約書のチェックをお願いしたい',
  '💰 経費精算・領収書について聞きたい',
  '🏢 住所変更や備品の相談がある',
];

const getNowTime = () =>
  new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

const getNowFullLabel = () =>
  new Date().toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

const getTaskDate = (ts?: FirestoreTimestamp | null): Date => {
  if (!ts || typeof ts.toDate !== 'function') return new Date();
  return ts.toDate();
};

const formatTimestamp = (ts?: FirestoreTimestamp | null) => {
  if (!ts || typeof ts.toDate !== 'function') return 'たった今';
  return ts.toDate().toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const parseEmails = (raw?: string): string[] => {
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(/[,、;\s]+/)
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.includes('@'))
    )
  );
};

// 単一部署（過去データ）・複数部署のどちらにも対応して配列で返す
const getTaskDepts = (task: Pick<Task, 'recommendedDept' | 'recommendedDepts'>): string[] => {
  if (Array.isArray(task.recommendedDepts) && task.recommendedDepts.length > 0) {
    return Array.from(new Set(task.recommendedDepts.filter(Boolean)));
  }
  if (task.recommendedDept && task.recommendedDept.trim()) {
    return [task.recommendedDept.trim()];
  }
  return [];
};

const getProposalDepts = (proposal: Proposal): string[] => {
  if (Array.isArray(proposal.departments) && proposal.departments.length > 0) {
    return Array.from(new Set(proposal.departments.filter(Boolean)));
  }
  if (proposal.department && proposal.department.trim()) {
    return [proposal.department.trim()];
  }
  return [];
};

const isSameDeptSet = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every((item) => setA.has(item));
};

// タイトル・詳細・複数部署・依頼者・タグ・履歴コメントを横断検索
const matchesSearchQuery = (task: Task, rawQuery: string): boolean => {
  const tokens = rawQuery
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return true;

  const historyText = (task.history || []).map((h) => `${h.text} ${h.actorName}`).join(' ');
  const searchable = [
    task.title,
    task.detail,
    getTaskDepts(task).join(' '),
    task.creatorName || '',
    task.creatorEmail || '',
    task.adminComment || '',
    task.priority || '通常',
    (task.tags || []).join(' '),
    historyText,
  ]
    .join(' ')
    .toLowerCase();

  return tokens.every((token) => searchable.includes(token));
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const buildFallbackProposal = (userText: string, departments: Department[]): Proposal => {
  const normalizedInput = userText.toLowerCase();
  const scored = departments.map((dept) => {
    const rawTokens = `${dept.name} ${dept.expertise}`
      .split(/[、,・\s（）()／/「」『』]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2);

    const hits: string[] = [];
    for (const token of rawTokens) {
      if (normalizedInput.includes(token.toLowerCase())) {
        hits.push(token);
      } else {
        const subWords =
          token.match(/[A-Za-z0-9]{2,}|[\u4E00-\u9FFF]{2,4}|[ァ-ヶー]{2,}/g) || [];
        for (const sub of subWords) {
          if (normalizedInput.includes(sub.toLowerCase()) && !hits.includes(sub)) {
            hits.push(sub);
          }
        }
      }
    }
    return { dept, hits };
  });

  scored.sort((a, b) => b.hits.length - a.hits.length);

  const topScore = scored[0]?.hits.length ?? 0;
  // 複数部署に明確なキーワード一致がある場合は複数ピックアップ
  const picked =
    topScore > 0
      ? scored.filter((item, idx) => idx === 0 || item.hits.length >= Math.max(2, topScore))
      : [scored[0]];

  const pickedNames = picked.map((p) => p.dept.name);
  const allMatchedKeywords = Array.from(new Set(picked.flatMap((p) => p.hits)));

  const isUrgent = /急ぎ|至急|緊急|本日中|今日中|止まっ|つながら|映らない/.test(userText);
  const cleanTitle = userText.replace(/\s+/g, ' ').slice(0, 19);

  return {
    department: pickedNames.join('・'),
    departments: pickedNames,
    title: cleanTitle + (userText.length > 19 ? '…' : ''),
    detail: userText,
    reason:
      allMatchedKeywords.length > 0
        ? `相談内容のキーワード（${allMatchedKeywords.slice(0, 4).join('・')}）から「${pickedNames.join('・')}」を担当候補と判定しました。`
        : `登録されている得意分野から「${pickedNames[0]}」を窓口として選択しました。`,
    tags:
      allMatchedKeywords.length > 0
        ? allMatchedKeywords.slice(0, 3)
        : ['社内相談', pickedNames[0]],
    priority: isUrgent ? '急ぎ' : '通常',
  };
};

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [activeTab, setActiveTab] = useState<'chat' | 'mypage' | 'admin'>('chat');
  const [mypageView, setMypageView] = useState<'requested' | 'assigned'>('requested');
  const [adminView, setAdminView] = useState<'board' | 'analytics' | 'departments'>('board');
  const [deptFilter, setDeptFilter] = useState<string>('すべて');
  const [myDeptFilter, setMyDeptFilter] = useState<string>('すべて');

  // キーワード検索 ＆ 優先度絞り込み用State
  const [boardSearchQuery, setBoardSearchQuery] = useState('');
  const [boardUrgentOnly, setBoardUrgentOnly] = useState(false);
  const [mypageSearchQuery, setMypageSearchQuery] = useState('');

  const [tasks, setTasks] = useState<Task[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [showNotifMenu, setShowNotifMenu] = useState(false);
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});

  // 詳細モーダル用State
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [modalCommentText, setModalCommentText] = useState('');
  const [isPostingComment, setIsPostingComment] = useState(false);
  const [editTaskDepts, setEditTaskDepts] = useState<string[]>([]);
  const [isUpdatingDepts, setIsUpdatingDepts] = useState(false);

  // 部署管理・兼任設定用State
  const [newDeptName, setNewDeptName] = useState('');
  const [newDeptExpertise, setNewDeptExpertise] = useState('');
  const [newDeptEmail, setNewDeptEmail] = useState('');
  const [deptEmailDrafts, setDeptEmailDrafts] = useState<Record<string, string>>({});
  const [deptExpertiseDrafts, setDeptExpertiseDrafts] = useState<Record<string, string>>({});
  const [bulkEmail, setBulkEmail] = useState('');
  const [bulkDeptIds, setBulkDeptIds] = useState<string[]>([]);

  // チャット用State
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'ai',
      text: 'こんにちは！社内ヘルプデスクAIです。\n困っていることをそのまま話しかけていただければ、最適な担当部署をお探しして依頼をまとめます。',
      time: getNowTime(),
    },
  ]);
  const [inputText, setInputText] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [thinkingText, setThinkingText] = useState('');
  const [isSendingBoard, setIsSendingBoard] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const unsubscribe = onSnapshot(
      query(collection(db, 'tasks'), orderBy('createdAt', 'desc')),
      (snapshot) => {
        setTasks(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })) as Task[]);
      }
    );
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const unsubscribe = onSnapshot(collection(db, 'departments'), (snapshot) => {
      setDepartments(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })) as Department[]);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const unsubscribe = onSnapshot(
      query(collection(db, 'notifications'), orderBy('createdAt', 'desc')),
      (snapshot) => {
        setNotifications(
          snapshot.docs.map((d) => ({ id: d.id, ...d.data() })) as AppNotification[]
        );
      }
    );
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isThinking, thinkingText]);

  const openTaskModal = (task: Task) => {
    setSelectedTaskId(task.id);
    setEditTaskDepts(getTaskDepts(task));
    setModalCommentText('');
  };

  // 指定された複数部署の担当部長メールアドレスを重複なく取得
  const collectManagerEmailsForDepts = (deptNameList: string[]): string[] => {
    const emails = deptNameList.flatMap((name) => {
      const found = departments.find((d) => d.name === name);
      return parseEmails(found?.managerEmail);
    });
    return Array.from(new Set(emails));
  };

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

  const requestAIReply = async (targetMessages: ChatMessage[]) => {
    setIsThinking(true);
    setThinkingText('最適な部署を考えています...');

    try {
      const deptListText = departments
        .map((d) => `・${d.name}（得意分野: ${d.expertise}）`)
        .join('\n');
      const conversationHistory = targetMessages
        .filter((m) => !m.isError)
        .map((m) => `${m.role === 'user' ? '社員' : 'AI'}: ${m.text}`)
        .join('\n');

      const systemPrompt = `あなたは親切な社内ヘルプデスク案内AIです。以下の【部署リスト】から最適な担当部署を判定してください。複数部署の連携が必要な場合は複数選んで構いません。
【部署リスト】
${deptListText}

【ルール】
1. 担当部署が判断できる場合は、深掘りしすぎず素早く依頼案（proposal）を作成して提示してください。
2. 情報が曖昧すぎて部署が判断できない場合のみ、優しく1つだけ質問を返し proposal は null にしてください。
3. 必ず以下のJSON形式のみで出力してください。

【出力JSON】
{
  "reply": "社員への自然な返信メッセージ",
  "proposal": {
    "departments": ["リストにある部署名1", "必要に応じて部署名2"],
    "title": "管理ボード用の簡潔なタイトル（20文字以内）",
    "detail": "担当部署がすぐ動けるように要点をまとめた依頼詳細",
    "reason": "この部署をおすすめする理由（1文）",
    "tags": ["タグ1", "タグ2", "タグ3"],
    "priority": "通常 または 急ぎ"
  }
}

【これまでの会話】
${conversationHistory}`;

      const url =
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=' +
        GEMINI_API_KEY;

      const maxAttempts = 3;
      let parsed: {
        reply: string;
        proposal?: (Partial<Proposal> & { department?: string; departments?: string[] }) | null;
      } | null = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: systemPrompt }] }],
            generationConfig: { responseMimeType: 'application/json' },
          }),
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          const errMsg = err?.error?.message || `通信エラー (${response.status})`;
          const isCongested =
            response.status === 503 ||
            response.status === 429 ||
            errMsg.includes('high demand') ||
            errMsg.includes('overloaded');

          if (isCongested && attempt < maxAttempts) {
            setThinkingText(
              `Googleサーバー混雑のため自動で再接続中... (${attempt}/${maxAttempts - 1})`
            );
            await sleep(attempt * 2000);
            continue;
          }
          throw new Error(errMsg);
        }

        const data = await response.json();
        const rawText = data.candidates[0].content.parts[0].text;
        parsed = JSON.parse(rawText.replace(/```json\n?|\n?```/g, '').trim());
        break;
      }

      if (parsed) {
        let normalizedProposal: Proposal | undefined;
        if (parsed.proposal) {
          const rawDepts =
            Array.isArray(parsed.proposal.departments) && parsed.proposal.departments.length > 0
              ? parsed.proposal.departments
              : parsed.proposal.department
              ? [parsed.proposal.department]
              : [departments[0]?.name || '未分類'];
          const uniqueDepts = Array.from(new Set(rawDepts.filter(Boolean)));
          normalizedProposal = {
            department: uniqueDepts.join('・'),
            departments: uniqueDepts,
            title: parsed.proposal.title || '社内相談',
            detail: parsed.proposal.detail || '',
            reason: parsed.proposal.reason || '',
            tags: Array.isArray(parsed.proposal.tags) ? parsed.proposal.tags : [],
            priority: parsed.proposal.priority === '急ぎ' ? '急ぎ' : '通常',
          };
        }

        setMessages([
          ...targetMessages,
          {
            role: 'ai',
            text: parsed.reply,
            time: getNowTime(),
            proposal: normalizedProposal,
          },
        ]);
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : '不明なエラー';
      const isHighDemand =
        msg.includes('high demand') || msg.includes('503') || msg.includes('429');
      setMessages([
        ...targetMessages,
        {
          role: 'ai',
          text: isHighDemand
            ? '⚠️ 現在GoogleのAIサーバーが大変混み合っています。\n「もう一度AIで試す」か、待たずにすぐカードを作れる「バックアップ自動判定」をご利用ください！'
            : `⚠️ エラーが発生しました: ${msg}`,
          time: getNowTime(),
          isError: true,
        },
      ]);
    } finally {
      setIsThinking(false);
      setThinkingText('');
    }
  };

  const handleSendMessage = async (overrideText?: string) => {
    const textToSend = (overrideText ?? inputText).trim();
    if (!textToSend || isThinking) return;
    if (departments.length === 0) {
      alert('先に「全体管理 ＞ 部署・メール管理」から部署を1つ以上登録してください！');
      return;
    }

    const userMessage: ChatMessage = {
      role: 'user',
      text: textToSend,
      time: getNowTime(),
    };
    const updatedMessages = [...messages.filter((m) => !m.isError), userMessage];
    setMessages(updatedMessages);
    setInputText('');
    await requestAIReply(updatedMessages);
  };

  const handleRetry = async () => {
    if (isThinking) return;
    const cleanMessages = messages.filter((m) => !m.isError);
    setMessages(cleanMessages);
    await requestAIReply(cleanMessages);
  };

  const handleUseFallback = () => {
    const cleanMessages = messages.filter((m) => !m.isError);
    const userTexts = cleanMessages
      .filter((m) => m.role === 'user')
      .map((m) => m.text)
      .join(' ');
    if (!userTexts || departments.length === 0) return;

    const proposal = buildFallbackProposal(userTexts, departments);
    setMessages([
      ...cleanMessages,
      {
        role: 'ai',
        text: `バックアップ自動判定により、「${proposal.departments.join('・')}」宛ての依頼カードを作成しました！複数部署の選択や優先度をご確認のうえ送信してください。`,
        time: getNowTime(),
        proposal,
      },
    ]);
  };

  // チャット上の提案カードで複数部署をトグル選択
  const handleToggleProposalDept = (msgIndex: number, deptName: string) => {
    setMessages((prev) =>
      prev.map((m, idx) => {
        if (idx !== msgIndex || !m.proposal) return m;
        const current = getProposalDepts(m.proposal);
        const exists = current.includes(deptName);
        if (exists && current.length <= 1) {
          return m; // 最低1部署は選択状態を維持
        }
        const nextDepts = exists
          ? current.filter((d) => d !== deptName)
          : [...current, deptName];
        return {
          ...m,
          proposal: {
            ...m.proposal,
            departments: nextDepts,
            department: nextDepts.join('・'),
          },
        };
      })
    );
  };

  const handleUpdateProposalPriority = (msgIndex: number, priority: TaskPriority) => {
    setMessages((prev) =>
      prev.map((m, idx) =>
        idx === msgIndex && m.proposal
          ? { ...m, proposal: { ...m.proposal, priority } }
          : m
      )
    );
  };

  const handleCreateTaskFromProposal = async (proposal: Proposal, msgIndex: number) => {
    const selectedDepts = getProposalDepts(proposal);
    if (selectedDepts.length === 0) {
      alert('担当部署を1つ以上選択してください。');
      return;
    }

    setIsSendingBoard(true);
    try {
      const priority: TaskPriority = proposal.priority === '急ぎ' ? '急ぎ' : '通常';
      const deptDisplay = selectedDepts.join('・');
      const initialHistory: TaskHistoryItem[] = [
        {
          id: `${Date.now()}_init`,
          type: 'comment',
          text: `新規依頼を作成しました（担当：${deptDisplay} ／ 優先度：${priority}）：${proposal.title}`,
          actorName: user?.displayName || '社員',
          actorEmail: (user?.email || '').toLowerCase(),
          createdAtLabel: getNowFullLabel(),
        },
      ];

      const taskRef = await addDoc(collection(db, 'tasks'), {
        title: proposal.title,
        category: 'AIチャット相談',
        detail: proposal.detail,
        status: '未処理',
        priority,
        recommendedDept: deptDisplay,
        recommendedDepts: selectedDepts,
        aiReason: proposal.reason,
        tags: proposal.tags || [],
        createdBy: user?.uid || 'unknown',
        creatorName: user?.displayName || '社員',
        creatorEmail: (user?.email || '').toLowerCase(),
        creatorPhoto: user?.photoURL || '',
        history: initialHistory,
        createdAt: serverTimestamp(),
      });

      const managerEmails = collectManagerEmailsForDepts(selectedDepts);

      if (managerEmails.length > 0) {
        const titleWithPriority =
          priority === '急ぎ' ? `【急ぎ】${proposal.title}` : proposal.title;
        await Promise.all(
          managerEmails.map((email) =>
            addDoc(collection(db, 'notifications'), {
              targetEmail: email,
              kind: 'new_task',
              taskId: taskRef.id,
              taskTitle: titleWithPriority,
              department: deptDisplay,
              newStatus: '未処理',
              actorName: user?.displayName || '社員',
              read: false,
              createdAt: serverTimestamp(),
            })
          )
        );
      }

      setMessages((prev) =>
        prev.map((m, idx) => (idx === msgIndex ? { ...m, isSubmitted: true } : m))
      );

      const mailInfo =
        managerEmails.length > 0
          ? `\n（担当部長メール: ${managerEmails.join(', ')} へ通知を送信します）`
          : '\n（※担当部長メールアドレスが未設定のためメール通知はスキップされました）';
      alert(`🎉 「${deptDisplay}」宛てに依頼を送信しました！${mailInfo}`);
      setActiveTab('mypage');
      setMypageView('requested');
    } catch {
      alert('登録に失敗しました。');
    } finally {
      setIsSendingBoard(false);
    }
  };

  const handleStatusChange = async (
    task: Task,
    newStatus: '未処理' | '対応中' | '完了',
    overrideMemo?: string
  ) => {
    const memo = (overrideMemo ?? commentDrafts[task.id] ?? '').trim();
    const actor = user?.displayName || '担当者';
    const timeLabel = getNowFullLabel();

    const newHistoryItems: TaskHistoryItem[] = [
      {
        id: `${Date.now()}_st_${Math.random().toString(36).slice(2, 6)}`,
        type: 'status',
        text: `ステータスを「${task.status}」から「${newStatus}」に変更しました`,
        actorName: actor,
        actorEmail: (user?.email || '').toLowerCase(),
        statusTo: newStatus,
        createdAtLabel: timeLabel,
      },
    ];

    if (memo) {
      newHistoryItems.push({
        id: `${Date.now()}_cm_${Math.random().toString(36).slice(2, 6)}`,
        type: 'comment',
        text: memo,
        actorName: actor,
        actorEmail: (user?.email || '').toLowerCase(),
        createdAtLabel: timeLabel,
      });
    }

    const updatePayload: Record<string, unknown> = {
      status: newStatus,
      history: arrayUnion(...newHistoryItems),
    };
    if (memo) {
      updatePayload.adminComment = memo;
    }

    await updateDoc(doc(db, 'tasks', task.id), updatePayload);

    const taskDepts = getTaskDepts(task);
    const deptDisplay = taskDepts.join('・') || '担当部署';
    const requesterEmail = (task.creatorEmail || '').trim().toLowerCase();
    const managerEmails = collectManagerEmailsForDepts(taskDepts);

    const recipientEmails = Array.from(
      new Set([requesterEmail, ...managerEmails].filter(Boolean))
    );

    if (recipientEmails.length > 0) {
      await Promise.all(
        recipientEmails.map((email) =>
          addDoc(collection(db, 'notifications'), {
            targetUid: email === requesterEmail ? task.createdBy || '' : '',
            targetEmail: email,
            kind: 'status_update',
            taskId: task.id,
            taskTitle: task.title,
            department: deptDisplay,
            newStatus,
            comment: memo,
            actorName: actor,
            read: false,
            createdAt: serverTimestamp(),
          })
        )
      );
    } else if (task.createdBy && task.createdBy !== 'unknown') {
      await addDoc(collection(db, 'notifications'), {
        targetUid: task.createdBy,
        targetEmail: '',
        kind: 'status_update',
        taskId: task.id,
        taskTitle: task.title,
        department: deptDisplay,
        newStatus,
        comment: memo,
        actorName: actor,
        read: false,
        createdAt: serverTimestamp(),
      });
    }

    if (memo && !overrideMemo) {
      setCommentDrafts((prev) => ({ ...prev, [task.id]: '' }));
    }
  };

  const handlePriorityChange = async (task: Task, nextPriority: TaskPriority) => {
    const currentPriority: TaskPriority = task.priority === '急ぎ' ? '急ぎ' : '通常';
    if (currentPriority === nextPriority) return;

    const actor = user?.displayName || '担当者';
    const entry: TaskHistoryItem = {
      id: `${Date.now()}_pr_${Math.random().toString(36).slice(2, 6)}`,
      type: 'priority',
      text: `優先度を「${currentPriority}」から「${nextPriority}」に変更しました`,
      actorName: actor,
      actorEmail: (user?.email || '').toLowerCase(),
      createdAtLabel: getNowFullLabel(),
    };

    await updateDoc(doc(db, 'tasks', task.id), {
      priority: nextPriority,
      history: arrayUnion(entry),
    });
  };

  // モーダル内で複数部署のチェック切り替え
  const handleToggleModalDept = (deptName: string) => {
    setEditTaskDepts((prev) => {
      if (prev.includes(deptName)) {
        if (prev.length <= 1) return prev; // 最低1部署は残す
        return prev.filter((d) => d !== deptName);
      }
      return [...prev, deptName];
    });
  };

  // モーダル内からの担当部署（複数可）の更新・追加・振り替え
  const handleUpdateTaskDepartments = async (task: Task) => {
    const prevDepts = getTaskDepts(task);
    const nextDepts = Array.from(new Set(editTaskDepts.filter(Boolean)));
    if (nextDepts.length === 0 || isSameDeptSet(prevDepts, nextDepts) || isUpdatingDepts) {
      return;
    }

    const prevLabel = prevDepts.join('・') || '未分類';
    const nextLabel = nextDepts.join('・');
    const addedDepts = nextDepts.filter((d) => !prevDepts.includes(d));

    if (
      !confirm(
        `担当部署を「${prevLabel}」から「${nextLabel}」へ更新しますか？` +
          (addedDepts.length > 0
            ? `\n（新たに追加される ${addedDepts.join('・')} の部長アドレスへ通知が送られます）`
            : '')
      )
    ) {
      return;
    }

    setIsUpdatingDepts(true);
    try {
      const actor = user?.displayName || '担当者';
      const noteText = `担当部署を「${prevLabel}」から「${nextLabel}」へ更新しました`;
      const entry: TaskHistoryItem = {
        id: `${Date.now()}_tr_${Math.random().toString(36).slice(2, 6)}`,
        type: 'transfer',
        text: noteText,
        actorName: actor,
        actorEmail: (user?.email || '').toLowerCase(),
        createdAtLabel: getNowFullLabel(),
      };

      await updateDoc(doc(db, 'tasks', task.id), {
        recommendedDept: nextLabel,
        recommendedDepts: nextDepts,
        adminComment: noteText,
        history: arrayUnion(entry),
      });

      // 新たに追加された部署の部長メール宛てに新規依頼通知
      const addedManagerEmails = collectManagerEmailsForDepts(addedDepts);
      const titleForMail =
        task.priority === '急ぎ' ? `【急ぎ・担当追加】${task.title}` : `【担当追加】${task.title}`;

      if (addedManagerEmails.length > 0) {
        await Promise.all(
          addedManagerEmails.map((email) =>
            addDoc(collection(db, 'notifications'), {
              targetEmail: email,
              kind: 'new_task',
              taskId: task.id,
              taskTitle: titleForMail,
              department: nextLabel,
              newStatus: task.status,
              actorName: `${actor}（担当部署を更新）`,
              read: false,
              createdAt: serverTimestamp(),
            })
          )
        );
      }

      // 依頼者にも担当変更をお知らせ
      const requesterEmail = (task.creatorEmail || '').trim().toLowerCase();
      if (requesterEmail && !addedManagerEmails.includes(requesterEmail)) {
        await addDoc(collection(db, 'notifications'), {
          targetUid: task.createdBy || '',
          targetEmail: requesterEmail,
          kind: 'status_update',
          taskId: task.id,
          taskTitle: task.title,
          department: nextLabel,
          newStatus: task.status,
          comment: noteText,
          actorName: actor,
          read: false,
          createdAt: serverTimestamp(),
        });
      }

      alert(
        `✅ 担当部署を「${nextLabel}」へ更新しました！` +
          (addedManagerEmails.length > 0
            ? `\n（追加部署の担当メール: ${addedManagerEmails.join(', ')} へ通知を送信します）`
            : '')
      );
    } catch {
      alert('担当部署の更新に失敗しました。');
    } finally {
      setIsUpdatingDepts(false);
    }
  };

  const handleAddModalComment = async (task: Task) => {
    const text = modalCommentText.trim();
    if (!text || isPostingComment) return;

    setIsPostingComment(true);
    try {
      const actor = user?.displayName || '担当者';
      const entry: TaskHistoryItem = {
        id: `${Date.now()}_c_${Math.random().toString(36).slice(2, 6)}`,
        type: 'comment',
        text,
        actorName: actor,
        actorEmail: (user?.email || '').toLowerCase(),
        createdAtLabel: getNowFullLabel(),
      };

      await updateDoc(doc(db, 'tasks', task.id), {
        adminComment: text,
        history: arrayUnion(entry),
      });

      const taskDepts = getTaskDepts(task);
      const deptDisplay = taskDepts.join('・') || '担当部署';
      const requesterEmail = (task.creatorEmail || '').trim().toLowerCase();
      const managerEmails = collectManagerEmailsForDepts(taskDepts);
      const recipientEmails = Array.from(
        new Set([requesterEmail, ...managerEmails].filter(Boolean))
      );

      if (recipientEmails.length > 0) {
        await Promise.all(
          recipientEmails.map((email) =>
            addDoc(collection(db, 'notifications'), {
              targetUid: email === requesterEmail ? task.createdBy || '' : '',
              targetEmail: email,
              kind: 'status_update',
              taskId: task.id,
              taskTitle: task.title,
              department: deptDisplay,
              newStatus: task.status,
              comment: text,
              actorName: actor,
              read: false,
              createdAt: serverTimestamp(),
            })
          )
        );
      }

      setModalCommentText('');
    } catch {
      alert('コメントの投稿に失敗しました。');
    } finally {
      setIsPostingComment(false);
    }
  };

  const handleDeleteTask = async (task: Task) => {
    if (!confirm(`依頼「${task.title}」を削除しますか？この操作は取り消せません。`)) return;
    try {
      await deleteDoc(doc(db, 'tasks', task.id));
      if (selectedTaskId === task.id) {
        setSelectedTaskId(null);
      }
    } catch {
      alert('削除に失敗しました。');
    }
  };

  const handleMarkAllRead = async (list: AppNotification[]) => {
    const unread = list.filter((n) => !n.read);
    await Promise.all(
      unread.map((n) => updateDoc(doc(db, 'notifications', n.id), { read: true }))
    );
  };

  const handleAddDepartment = async () => {
    if (!newDeptName.trim() || !newDeptExpertise.trim()) return;
    await addDoc(collection(db, 'departments'), {
      name: newDeptName.trim(),
      expertise: newDeptExpertise.trim(),
      managerEmail: parseEmails(newDeptEmail).join(', '),
    });
    setNewDeptName('');
    setNewDeptExpertise('');
    setNewDeptEmail('');
  };

  const handleSaveDeptDetails = async (dept: Department) => {
    const nextExpertise = (deptExpertiseDrafts[dept.id] ?? dept.expertise).trim();
    if (!nextExpertise) {
      alert('得意分野を入力してください。');
      return;
    }
    const rawEmail = deptEmailDrafts[dept.id] ?? dept.managerEmail ?? '';
    const cleanedEmail = parseEmails(rawEmail).join(', ');

    await updateDoc(doc(db, 'departments', dept.id), {
      expertise: nextExpertise,
      managerEmail: cleanedEmail,
    });

    setDeptExpertiseDrafts((prev) => ({ ...prev, [dept.id]: nextExpertise }));
    setDeptEmailDrafts((prev) => ({ ...prev, [dept.id]: cleanedEmail }));
    alert(`✅ 「${dept.name}」の得意分野・担当メールを保存しました！`);
  };

  const syncBulkSelectionForEmail = (emailStr: string) => {
    setBulkEmail(emailStr);
    const target = emailStr.trim().toLowerCase();
    if (!target || !target.includes('@')) {
      setBulkDeptIds([]);
      return;
    }
    const matchedIds = departments
      .filter((d) => parseEmails(d.managerEmail).includes(target))
      .map((d) => d.id);
    setBulkDeptIds(matchedIds);
  };

  const toggleBulkDept = (deptId: string) => {
    setBulkDeptIds((prev) =>
      prev.includes(deptId) ? prev.filter((id) => id !== deptId) : [...prev, deptId]
    );
  };

  const handleSaveBulkAssignment = async () => {
    const targetEmail = bulkEmail.trim().toLowerCase();
    if (!targetEmail || !targetEmail.includes('@')) {
      alert('有効なメールアドレスを入力してください。');
      return;
    }

    await Promise.all(
      departments.map(async (dept) => {
        const currentList = parseEmails(dept.managerEmail);
        const isChecked = bulkDeptIds.includes(dept.id);
        let nextList = currentList;

        if (isChecked && !currentList.includes(targetEmail)) {
          nextList = [...currentList, targetEmail];
        } else if (!isChecked && currentList.includes(targetEmail)) {
          nextList = currentList.filter((e) => e !== targetEmail);
        } else {
          return;
        }

        const joined = nextList.join(', ');
        await updateDoc(doc(db, 'departments', dept.id), { managerEmail: joined });
        setDeptEmailDrafts((prev) => ({ ...prev, [dept.id]: joined }));
      })
    );

    alert(`✅ ${targetEmail} に ${bulkDeptIds.length}個の担当部署を紐づけました！`);
  };

  if (!user) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-950 to-indigo-950 flex items-center justify-center p-6">
        <div className="bg-white/95 backdrop-blur-md p-10 rounded-3xl shadow-2xl border border-white/20 max-w-md w-full text-center">
          <div className="w-16 h-16 bg-gradient-to-tr from-blue-600 to-indigo-500 rounded-2xl mx-auto mb-6 flex items-center justify-center shadow-lg shadow-blue-500/30 text-3xl">
            ✨
          </div>
          <h1 className="text-3xl font-black tracking-tight text-slate-900 mb-2">
            Task-AI
          </h1>
          <p className="text-slate-500 text-sm mb-8 leading-relaxed">
            「誰に聞けばいい？」をAIが一瞬で解決。<br />
            社内ヘルプデスク＆タスク管理プラットフォーム
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
  const selectedTask = tasks.find((t) => t.id === selectedTaskId) || null;
  const selectedTaskDepts = selectedTask ? getTaskDepts(selectedTask) : [];

  const myAssignedDepts = departments.filter((d) =>
    parseEmails(d.managerEmail).includes(userEmail)
  );
  const myAssignedDeptNames = myAssignedDepts.map((d) => d.name);

  const myTasks = tasks.filter(
    (t) =>
      t.createdBy === user.uid ||
      (userEmail && (t.creatorEmail || '').toLowerCase() === userEmail)
  );
  const filteredMyTasks = myTasks.filter((t) => matchesSearchQuery(t, mypageSearchQuery));
  const myPending = myTasks.filter((t) => t.status === '未処理').length;
  const myInProgress = myTasks.filter((t) => t.status === '対応中').length;
  const myCompleted = myTasks.filter((t) => t.status === '完了').length;

  // 複数部署のどれか1つでも自分の担当部署に含まれていれば表示
  const allAssignedTasks = tasks.filter((t) =>
    getTaskDepts(t).some((deptName) => myAssignedDeptNames.includes(deptName))
  );
  const myDeptActiveCount = allAssignedTasks.filter((t) => t.status !== '完了').length;
  const displayedAssignedTasks = (
    myDeptFilter === 'すべて'
      ? allAssignedTasks
      : allAssignedTasks.filter((t) => getTaskDepts(t).includes(myDeptFilter))
  )
    .filter((t) => matchesSearchQuery(t, mypageSearchQuery))
    .sort((a, b) => Number(b.priority === '急ぎ') - Number(a.priority === '急ぎ'));

  const myNotifications = notifications.filter((n) => {
    const tEmail = (n.targetEmail || '').toLowerCase();
    if (tEmail && userEmail) return tEmail === userEmail;
    return Boolean(n.targetUid && n.targetUid === user.uid);
  });
  const unreadNotifications = myNotifications.filter((n) => !n.read);

  // 全体管理ボードの絞り込み（複数部署対応 × 急ぎのみ × キーワード検索）
  const filteredBoardTasks = tasks.filter((t) => {
    if (deptFilter !== 'すべて' && !getTaskDepts(t).includes(deptFilter)) return false;
    if (boardUrgentOnly && t.priority !== '急ぎ') return false;
    return matchesSearchQuery(t, boardSearchQuery);
  });

  const urgentActiveCount = tasks.filter(
    (t) => t.priority === '急ぎ' && t.status !== '完了'
  ).length;

  const totalCount = tasks.length;
  const pendingCount = tasks.filter((t) => t.status === '未処理').length;
  const inProgressCount = tasks.filter((t) => t.status === '対応中').length;
  const completedCount = tasks.filter((t) => t.status === '完了').length;
  const completionRate = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  // 分析ダッシュボードの部署別集計（複数部署関与タスクも各部署にカウント）
  const deptNames = Array.from(
    new Set([
      ...departments.map((d) => d.name),
      ...tasks.flatMap((t) => {
        const list = getTaskDepts(t);
        return list.length > 0 ? list : ['未分類'];
      }),
    ])
  ).filter(Boolean);

  const deptStats = deptNames
    .map((name) => {
      const dTasks = tasks.filter((t) => {
        const list = getTaskDepts(t);
        if (list.length === 0) return name === '未分類';
        return list.includes(name);
      });
      return {
        name,
        total: dTasks.length,
        pending: dTasks.filter((t) => t.status === '未処理').length,
        inProgress: dTasks.filter((t) => t.status === '対応中').length,
        completed: dTasks.filter((t) => t.status === '完了').length,
      };
    })
    .sort((a, b) => b.total - a.total);

  const maxDeptCount = Math.max(...deptStats.map((d) => d.total), 1);
  const topDeptName = deptStats[0]?.total > 0 ? deptStats[0].name : 'データなし';

  const dailyStats = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    const label = `${d.getMonth() + 1}/${d.getDate()}`;
    const count = tasks.filter((t) => {
      const td = getTaskDate(t.createdAt);
      return `${td.getFullYear()}-${td.getMonth() + 1}-${td.getDate()}` === key;
    }).length;
    return { label, count };
  });
  const maxDailyCount = Math.max(...dailyStats.map((d) => d.count), 1);

  const tagCounts: Record<string, number> = {};
  tasks.forEach((t) => {
    (t.tags || []).forEach((tag) => {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    });
  });
  const topTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const statusConfig = [
    {
      key: '未処理' as const,
      label: '未処理',
      dot: 'bg-blue-500',
      badge: 'bg-blue-100 text-blue-700',
      columnBg: 'bg-slate-100/80',
    },
    {
      key: '対応中' as const,
      label: '対応中',
      dot: 'bg-amber-500',
      badge: 'bg-amber-100 text-amber-700',
      columnBg: 'bg-amber-50/40',
    },
    {
      key: '完了' as const,
      label: '完了',
      dot: 'bg-emerald-500',
      badge: 'bg-emerald-100 text-emerald-700',
      columnBg: 'bg-emerald-50/40',
    },
  ];

  const modalHistoryList: TaskHistoryItem[] = (() => {
    if (!selectedTask) return [];
    if (selectedTask.history && selectedTask.history.length > 0) {
      return selectedTask.history;
    }
    const fallback: TaskHistoryItem[] = [
      {
        id: 'legacy_init',
        type: 'comment',
        text: `依頼が登録されました：${selectedTask.title}`,
        actorName: selectedTask.creatorName || '社員',
        createdAtLabel: formatTimestamp(selectedTask.createdAt),
      },
    ];
    if (selectedTask.adminComment) {
      fallback.push({
        id: 'legacy_memo',
        type: 'comment',
        text: selectedTask.adminComment,
        actorName: '担当者',
        createdAtLabel: '最新',
      });
    }
    return fallback;
  })();

  // モーダルで選択可能な全部署リスト（登録済み部署＋カード固有の部署名）
  const modalSelectableDeptNames = Array.from(
    new Set([...departments.map((d) => d.name), ...selectedTaskDepts])
  );

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-800 flex flex-col">
      {/* ヘッダー */}
      <header className="bg-white/90 backdrop-blur-md border-b border-slate-200/80 px-4 md:px-8 py-3.5 flex flex-wrap items-center justify-between gap-4 sticky top-0 z-30">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 bg-gradient-to-tr from-blue-600 to-indigo-500 rounded-xl flex items-center justify-center text-white font-black shadow-sm">
            T
          </div>
          <span className="text-xl font-black tracking-tight bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent">
            Task-AI
          </span>
        </div>

        <nav className="flex gap-1 bg-slate-100 p-1 rounded-xl">
          <button
            onClick={() => setActiveTab('chat')}
            className={`px-4 py-2 rounded-lg font-bold text-xs md:text-sm transition-all ${
              activeTab === 'chat'
                ? 'bg-white text-blue-600 shadow-sm'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            💬 AIに相談
          </button>
          <button
            onClick={() => setActiveTab('mypage')}
            className={`px-4 py-2 rounded-lg font-bold text-xs md:text-sm transition-all flex items-center gap-1.5 ${
              activeTab === 'mypage'
                ? 'bg-white text-blue-600 shadow-sm'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            👤 マイページ
            {myPending + myInProgress + myDeptActiveCount > 0 && (
              <span className="bg-blue-600 text-white text-[10px] px-1.5 py-0.5 rounded-full">
                {myPending + myInProgress + myDeptActiveCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('admin')}
            className={`px-4 py-2 rounded-lg font-bold text-xs md:text-sm transition-all flex items-center gap-1.5 ${
              activeTab === 'admin'
                ? 'bg-white text-blue-600 shadow-sm'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            📋 全体管理
            {urgentActiveCount > 0 && (
              <span className="bg-rose-500 text-white text-[10px] px-1.5 py-0.5 rounded-full">
                🔥{urgentActiveCount}
              </span>
            )}
          </button>
        </nav>

        <div className="flex items-center gap-3 relative">
          <button
            onClick={() => setShowNotifMenu((prev) => !prev)}
            className="relative p-2 rounded-xl bg-slate-100 hover:bg-slate-200/80 text-slate-700 transition-colors"
            title="通知一覧"
          >
            🔔
            {unreadNotifications.length > 0 && (
              <span className="absolute -top-1 -right-1 bg-rose-500 text-white text-[10px] font-black w-5 h-5 rounded-full flex items-center justify-center shadow">
                {unreadNotifications.length}
              </span>
            )}
          </button>

          {showNotifMenu && (
            <div className="absolute right-0 top-12 w-80 sm:w-96 bg-white rounded-2xl shadow-2xl border border-slate-200 z-50 overflow-hidden">
              <div className="px-4 py-3 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
                <span className="font-bold text-sm text-slate-800">
                  🔔 お知らせ（{unreadNotifications.length}件未読）
                </span>
                {unreadNotifications.length > 0 && (
                  <button
                    onClick={() => handleMarkAllRead(myNotifications)}
                    className="text-xs text-blue-600 font-bold hover:underline"
                  >
                    すべて既読
                  </button>
                )}
              </div>
              <div className="max-h-80 overflow-y-auto divide-y divide-slate-100">
                {myNotifications.length === 0 ? (
                  <p className="text-xs text-slate-400 text-center py-8">
                    まだ通知はありません
                  </p>
                ) : (
                  myNotifications.slice(0, 20).map((n) => (
                    <div
                      key={n.id}
                      onClick={async () => {
                        if (!n.read) {
                          await updateDoc(doc(db, 'notifications', n.id), { read: true });
                        }
                        setShowNotifMenu(false);
                        const found = tasks.find((t) => t.id === n.taskId);
                        if (found) {
                          openTaskModal(found);
                        } else {
                          setActiveTab('mypage');
                          setMypageView(n.kind === 'new_task' ? 'assigned' : 'requested');
                        }
                      }}
                      className={`p-3.5 cursor-pointer hover:bg-slate-50 transition-colors ${
                        !n.read ? 'bg-blue-50/40' : ''
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 mb-1">
                        {n.kind === 'new_task' ? (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700">
                            📥 新規依頼（{n.department}）
                          </span>
                        ) : (
                          <span
                            className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                              n.newStatus === '完了'
                                ? 'bg-emerald-100 text-emerald-700'
                                : n.newStatus === '対応中'
                                ? 'bg-amber-100 text-amber-700'
                                : 'bg-blue-100 text-blue-700'
                            }`}
                          >
                            進捗：{n.newStatus}
                          </span>
                        )}
                        <span className="text-[10px] text-slate-400">
                          {formatTimestamp(n.createdAt)}
                        </span>
                      </div>
                      <p className="text-xs font-bold text-slate-800">「{n.taskTitle}」</p>
                      <p className="text-[11px] text-slate-500 mt-0.5">
                        {n.kind === 'new_task'
                          ? `${n.actorName} さんから相談が届きました`
                          : `${n.department}（${n.actorName}）がステータスを更新しました`}
                      </p>
                      {n.comment && (
                        <p className="text-xs bg-slate-100 text-slate-700 p-2 rounded-lg mt-1.5">
                          💬 {n.comment}
                        </p>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {user.photoURL ? (
            <img
              src={user.photoURL}
              alt="icon"
              className="w-8 h-8 rounded-full ring-2 ring-slate-100"
            />
          ) : (
            <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-700 font-bold flex items-center justify-center text-xs">
              {user.displayName?.[0] || 'U'}
            </div>
          )}
          <div className="hidden sm:block text-left">
            <p className="text-xs font-bold text-slate-700 leading-tight">{user.displayName}</p>
            <p className="text-[10px] text-slate-400 leading-tight">{user.email}</p>
          </div>
          <button
            onClick={handleLogout}
            className="text-xs text-slate-400 hover:text-slate-600 border border-slate-200 px-2.5 py-1 rounded-lg transition-colors"
          >
            ログアウト
          </button>
        </div>
      </header>

      <main className="flex-1 p-4 md:p-8" onClick={() => showNotifMenu && setShowNotifMenu(false)}>
        {/* =========================================
            【1】AIチャット画面
        ========================================= */}
        {activeTab === 'chat' && (
          <div className="max-w-3xl mx-auto bg-white rounded-3xl shadow-sm border border-slate-200/80 flex flex-col h-[78vh] overflow-hidden">
            <div className="px-6 py-4 bg-gradient-to-r from-blue-600 to-indigo-600 text-white flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-white/20 backdrop-blur rounded-2xl flex items-center justify-center text-xl">
                  🤖
                </div>
                <div>
                  <h2 className="font-bold text-sm md:text-base">社内お困りごと案内AI</h2>
                  <p className="text-[11px] text-blue-100 flex items-center gap-1.5">
                    <span className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse"></span>
                    オンライン・登録部署 {departments.length}件から最適判定（複数部署連携対応）
                  </p>
                </div>
              </div>
              <button
                onClick={() =>
                  setMessages([
                    {
                      role: 'ai',
                      text: '会話をリセットしました！新しいご相談をどうぞ。',
                      time: getNowTime(),
                    },
                  ])
                }
                className="text-xs bg-white/15 hover:bg-white/25 text-white px-3 py-1.5 rounded-xl transition-colors"
              >
                リセット
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 md:p-6 space-y-6 bg-slate-50/70">
              {departments.length === 0 && (
                <div className="bg-amber-50 text-amber-800 p-4 rounded-2xl text-xs md:text-sm border border-amber-200 flex items-center justify-between gap-3">
                  <span>⚠️ 先に「全体管理 ＞ 部署・メール管理」から部署を登録してください。</span>
                  <button
                    onClick={() => {
                      setActiveTab('admin');
                      setAdminView('departments');
                    }}
                    className="bg-amber-600 text-white px-3 py-1.5 rounded-lg font-bold text-xs shrink-0"
                  >
                    登録へ移動
                  </button>
                </div>
              )}

              {messages.map((msg, index) => (
                <div
                  key={index}
                  className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}
                >
                  {msg.role === 'ai' ? (
                    <div className="w-9 h-9 rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-500 text-white flex items-center justify-center text-base shrink-0 shadow-sm mt-1">
                      🤖
                    </div>
                  ) : user.photoURL ? (
                    <img
                      src={user.photoURL}
                      alt=""
                      className="w-9 h-9 rounded-full shrink-0 border border-slate-200 mt-1"
                    />
                  ) : (
                    <div className="w-9 h-9 rounded-full bg-blue-100 text-blue-700 font-bold flex items-center justify-center text-xs shrink-0 mt-1">
                      {user.displayName?.[0] || 'U'}
                    </div>
                  )}

                  <div
                    className={`flex flex-col max-w-[82%] ${
                      msg.role === 'user' ? 'items-end' : 'items-start'
                    }`}
                  >
                    <div
                      className={`px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap shadow-sm ${
                        msg.role === 'user'
                          ? 'bg-blue-600 text-white rounded-tr-sm'
                          : msg.isError
                          ? 'bg-amber-50 text-amber-900 border border-amber-200 rounded-tl-sm'
                          : 'bg-white text-slate-800 border border-slate-200/80 rounded-tl-sm'
                      }`}
                    >
                      {msg.text}
                      {msg.isError && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            onClick={handleRetry}
                            disabled={isThinking}
                            className="bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold px-3.5 py-2 rounded-xl shadow-sm transition-all active:scale-95"
                          >
                            🔄 もう一度AIで試す
                          </button>
                          <button
                            onClick={handleUseFallback}
                            disabled={isThinking}
                            className="bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold px-3.5 py-2 rounded-xl shadow-sm transition-all active:scale-95"
                          >
                            ⚡ バックアップ自動判定でカードを作る
                          </button>
                        </div>
                      )}
                    </div>
                    <span className="text-[10px] text-slate-400 mt-1 px-1">{msg.time}</span>

                    {msg.proposal && (() => {
                      const proposalDepts = getProposalDepts(msg.proposal);
                      const selectableDepts = Array.from(
                        new Set([...departments.map((d) => d.name), ...proposalDepts])
                      );
                      return (
                        <div className="mt-3 w-full max-w-md bg-white border border-blue-200 rounded-2xl overflow-hidden shadow-md">
                          <div className="bg-blue-50/80 px-4 py-3 border-b border-blue-100 space-y-2">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-extrabold text-blue-700">
                                🎯 送信先部署（複数選択OK）
                              </span>
                              <span className="text-[11px] font-bold text-blue-600">
                                {proposalDepts.length}部署選択中
                              </span>
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {selectableDepts.map((deptName) => {
                                const checked = proposalDepts.includes(deptName);
                                return (
                                  <button
                                    key={deptName}
                                    type="button"
                                    disabled={msg.isSubmitted}
                                    onClick={() => handleToggleProposalDept(index, deptName)}
                                    className={`text-[11px] font-bold px-2.5 py-1 rounded-lg border transition-all flex items-center gap-1 ${
                                      checked
                                        ? 'bg-blue-600 text-white border-blue-600 shadow-2xs'
                                        : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300'
                                    } disabled:opacity-70`}
                                  >
                                    <span>{checked ? '☑' : '☐'}</span>
                                    {deptName}
                                  </button>
                                );
                              })}
                            </div>
                          </div>

                          <div className="p-4 space-y-3">
                            <p className="text-xs text-blue-700 bg-blue-50/60 p-2.5 rounded-xl">
                              💡 {msg.proposal.reason}
                            </p>
                            <div>
                              <span className="text-[10px] font-bold text-slate-400 uppercase">
                                依頼タイトル
                              </span>
                              <p className="font-bold text-slate-900 text-sm">
                                {msg.proposal.title}
                              </p>
                            </div>
                            <div>
                              <span className="text-[10px] font-bold text-slate-400 uppercase">
                                要約内容
                              </span>
                              <p className="text-xs text-slate-600 leading-relaxed">
                                {msg.proposal.detail}
                              </p>
                            </div>

                            {/* 優先度選択（通常 / 急ぎ） */}
                            <div className="flex items-center justify-between bg-slate-50 px-3 py-2 rounded-xl border border-slate-200/80">
                              <span className="text-[11px] font-bold text-slate-600">優先度：</span>
                              <div className="flex gap-1.5">
                                {(['通常', '急ぎ'] as const).map((p) => {
                                  const currentP: TaskPriority =
                                    msg.proposal?.priority === '急ぎ' ? '急ぎ' : '通常';
                                  const active = currentP === p;
                                  return (
                                    <button
                                      key={p}
                                      type="button"
                                      disabled={msg.isSubmitted}
                                      onClick={() => handleUpdateProposalPriority(index, p)}
                                      className={`text-xs font-bold px-3 py-1 rounded-lg transition-all ${
                                        active
                                          ? p === '急ぎ'
                                            ? 'bg-rose-600 text-white shadow-xs'
                                            : 'bg-slate-800 text-white shadow-xs'
                                          : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-100'
                                      }`}
                                    >
                                      {p === '急ぎ' ? '🔥 急ぎ' : '通常'}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>

                            {msg.proposal.tags && msg.proposal.tags.length > 0 && (
                              <div className="flex flex-wrap gap-1.5">
                                {msg.proposal.tags.map((tag, i) => (
                                  <span
                                    key={i}
                                    className="text-[11px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full font-medium"
                                  >
                                    #{tag}
                                  </span>
                                ))}
                              </div>
                            )}
                            <button
                              onClick={() => handleCreateTaskFromProposal(msg.proposal!, index)}
                              disabled={isSendingBoard || msg.isSubmitted}
                              className={`w-full font-bold py-3 px-4 rounded-xl text-sm transition-all ${
                                msg.isSubmitted
                                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 cursor-default'
                                  : 'bg-blue-600 hover:bg-blue-700 text-white shadow-sm active:scale-95'
                              }`}
                            >
                              {msg.isSubmitted
                                ? '✓ ボードへ送信済み'
                                : isSendingBoard
                                ? '送信中...'
                                : `✨ 選択した${proposalDepts.length}部署へ依頼を送る`}
                            </button>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              ))}

              {isThinking && (
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-500 text-white flex items-center justify-center text-base">
                    🤖
                  </div>
                  <div className="bg-white border border-slate-200 px-4 py-3 rounded-2xl rounded-tl-sm flex items-center gap-2.5 shadow-sm">
                    <div className="flex items-center gap-1">
                      <span className="w-2 h-2 bg-blue-400 rounded-full animate-bounce"></span>
                      <span className="w-2 h-2 bg-blue-400 rounded-full animate-bounce [animation-delay:0.15s]"></span>
                      <span className="w-2 h-2 bg-blue-400 rounded-full animate-bounce [animation-delay:0.3s]"></span>
                    </div>
                    <span className="text-xs text-slate-500">{thinkingText}</span>
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {messages.length === 1 && departments.length > 0 && (
              <div className="px-5 py-2.5 bg-white border-t border-slate-100 flex flex-wrap gap-2">
                {QUICK_PROMPTS.map((q, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleSendMessage(q)}
                    className="text-xs bg-slate-50 hover:bg-blue-50 hover:text-blue-700 hover:border-blue-200 text-slate-600 border border-slate-200 px-3 py-1.5 rounded-full transition-colors"
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}

            <div className="p-4 bg-white border-t border-slate-200/80 flex gap-2.5">
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleSendMessage();
                }}
                placeholder="お困りごとを気軽に入力してください..."
                className="flex-1 px-4 py-3 rounded-xl bg-slate-50 border border-slate-200 focus:bg-white focus:ring-2 focus:ring-blue-500 outline-none text-sm transition-all"
              />
              <button
                onClick={() => handleSendMessage()}
                disabled={isThinking || !inputText.trim() || departments.length === 0}
                className="bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white font-bold px-6 py-3 rounded-xl text-sm shadow-sm transition-all active:scale-95"
              >
                送信
              </button>
            </div>
          </div>
        )}

        {/* =========================================
            【2】マイページ
        ========================================= */}
        {activeTab === 'mypage' && (
          <div className="max-w-5xl mx-auto space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-2xl font-black text-slate-900">マイページ</h2>
                <p className="text-sm text-slate-500">
                  カードをクリックすると優先度変更・複数部署の追加変更・コメント履歴が開きます
                </p>
              </div>
              <button
                onClick={() => setActiveTab('chat')}
                className="bg-blue-600 hover:bg-blue-700 text-white text-xs md:text-sm font-bold px-4 py-2.5 rounded-xl shadow-sm transition-all"
              >
                ＋ 新しく相談する
              </button>
            </div>

            <div className="bg-white p-4 rounded-2xl border border-slate-200/80 shadow-sm flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-bold text-slate-500">
                  📧 あなたの担当部署（{user.email}）：
                </span>
                {myAssignedDepts.length === 0 ? (
                  <span className="text-xs text-slate-400">未設定</span>
                ) : (
                  myAssignedDepts.map((d) => (
                    <span
                      key={d.id}
                      className="text-xs font-bold bg-indigo-50 text-indigo-700 border border-indigo-200 px-3 py-1 rounded-full"
                    >
                      🏢 {d.name}
                    </span>
                  ))
                )}
              </div>
              <button
                onClick={() => {
                  setActiveTab('admin');
                  setAdminView('departments');
                  if (user.email) syncBulkSelectionForEmail(user.email);
                }}
                className="text-xs font-bold text-blue-600 hover:underline"
              >
                ⚙️ 担当・兼任部署を設定する →
              </button>
            </div>

            {/* タブ切り替え ＆ マイページ内キーワード検索 */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex gap-2 bg-white p-1.5 rounded-2xl border border-slate-200 w-fit">
                <button
                  onClick={() => setMypageView('requested')}
                  className={`px-4 py-2 rounded-xl text-xs md:text-sm font-bold transition-all ${
                    mypageView === 'requested'
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  📤 自分がお願いした依頼（{myTasks.length}）
                </button>
                <button
                  onClick={() => setMypageView('assigned')}
                  className={`px-4 py-2 rounded-xl text-xs md:text-sm font-bold transition-all flex items-center gap-1.5 ${
                    mypageView === 'assigned'
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  📥 担当部署に届いた依頼
                  {myAssignedDepts.length > 0 && (
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                        mypageView === 'assigned'
                          ? 'bg-white/20 text-white'
                          : 'bg-amber-100 text-amber-700'
                      }`}
                    >
                      {myDeptActiveCount}件未完了
                    </span>
                  )}
                </button>
              </div>

              <div className="relative flex-1 min-w-[220px] max-w-sm">
                <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-xs">
                  🔍
                </span>
                <input
                  type="text"
                  value={mypageSearchQuery}
                  onChange={(e) => setMypageSearchQuery(e.target.value)}
                  placeholder="キーワード検索（タイトル・内容・履歴）..."
                  className="w-full bg-white border border-slate-200 rounded-xl pl-9 pr-8 py-2 text-xs outline-none focus:ring-2 focus:ring-blue-500"
                />
                {mypageSearchQuery && (
                  <button
                    onClick={() => setMypageSearchQuery('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 text-xs font-bold"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>

            {mypageView === 'requested' && (
              <>
                <div className="grid grid-cols-3 gap-4">
                  <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm">
                    <span className="text-xs font-bold text-slate-400">未処理</span>
                    <p className="text-3xl font-black text-blue-600 mt-1">
                      {myPending}
                      <span className="text-xs font-normal text-slate-400 ml-1">件</span>
                    </p>
                  </div>
                  <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm">
                    <span className="text-xs font-bold text-slate-400">対応中</span>
                    <p className="text-3xl font-black text-amber-500 mt-1">
                      {myInProgress}
                      <span className="text-xs font-normal text-slate-400 ml-1">件</span>
                    </p>
                  </div>
                  <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm">
                    <span className="text-xs font-bold text-slate-400">完了</span>
                    <p className="text-3xl font-black text-emerald-600 mt-1">
                      {myCompleted}
                      <span className="text-xs font-normal text-slate-400 ml-1">件</span>
                    </p>
                  </div>
                </div>

                <div className="bg-white rounded-3xl shadow-sm border border-slate-200/80 p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-bold text-slate-800">お願いした依頼の進捗</h3>
                    {mypageSearchQuery && (
                      <span className="text-xs text-slate-500">
                        検索結果：{filteredMyTasks.length}件
                      </span>
                    )}
                  </div>
                  {filteredMyTasks.length === 0 ? (
                    <div className="text-center py-14 border-2 border-dashed border-slate-100 rounded-2xl">
                      <p className="text-3xl mb-2">{mypageSearchQuery ? '🔎' : '📭'}</p>
                      <p className="text-slate-500 text-sm font-medium">
                        {mypageSearchQuery
                          ? `「${mypageSearchQuery}」に一致する依頼が見つかりませんでした`
                          : 'まだ依頼したタスクはありません'}
                      </p>
                      {!mypageSearchQuery && (
                        <button
                          onClick={() => setActiveTab('chat')}
                          className="mt-4 text-blue-600 text-sm font-bold hover:underline"
                        >
                          AIチャットで相談してみる →
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {filteredMyTasks.map((task) => {
                        const step =
                          task.status === '完了' ? 3 : task.status === '対応中' ? 2 : 1;
                        const logCount = task.history?.length || 0;
                        const isUrgent = task.priority === '急ぎ';
                        const taskDepts = getTaskDepts(task);
                        return (
                          <div
                            key={task.id}
                            onClick={() => openTaskModal(task)}
                            className={`cursor-pointer p-5 border rounded-2xl hover:border-blue-300 hover:bg-blue-50/20 transition-all ${
                              isUrgent && task.status !== '完了'
                                ? 'border-rose-300 bg-rose-50/20'
                                : 'border-slate-200/80'
                            }`}
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                              <div className="flex flex-wrap items-center gap-1.5">
                                {isUrgent && (
                                  <span className="text-[11px] font-extrabold bg-rose-100 text-rose-700 border border-rose-200 px-2.5 py-0.5 rounded-full">
                                    🔥 急ぎ
                                  </span>
                                )}
                                {taskDepts.map((dName) => (
                                  <span
                                    key={dName}
                                    className="text-xs font-bold bg-blue-50 text-blue-700 px-2.5 py-0.5 rounded-full"
                                  >
                                    🏢 {dName}
                                  </span>
                                ))}
                                {logCount > 0 && (
                                  <span className="text-[11px] font-bold bg-slate-100 text-slate-600 px-2.5 py-0.5 rounded-full">
                                    💬 履歴 {logCount}件
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-3">
                                <span className="text-xs text-slate-400">
                                  {formatTimestamp(task.createdAt)}
                                </span>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDeleteTask(task);
                                  }}
                                  className="text-xs text-red-500 hover:bg-red-50 font-bold px-2.5 py-1 rounded-lg transition-colors"
                                  title="この依頼を削除"
                                >
                                  削除
                                </button>
                              </div>
                            </div>

                            <h4 className="font-bold text-slate-900 mb-1.5">{task.title}</h4>
                            <p className="text-sm text-slate-600 leading-relaxed mb-4">
                              {task.detail}
                            </p>

                            <div className="bg-slate-50 p-3 rounded-xl mb-3">
                              <div className="flex items-center justify-between text-[11px] font-bold mb-1.5">
                                <span className={step >= 1 ? 'text-blue-600' : 'text-slate-400'}>
                                  ① 受付・未処理
                                </span>
                                <span className={step >= 2 ? 'text-amber-600' : 'text-slate-400'}>
                                  ② 担当者が対応中
                                </span>
                                <span className={step >= 3 ? 'text-emerald-600' : 'text-slate-400'}>
                                  ③ 対応完了
                                </span>
                              </div>
                              <div className="w-full h-2 bg-slate-200 rounded-full overflow-hidden">
                                <div
                                  className={`h-full transition-all duration-500 ${
                                    step === 3
                                      ? 'w-full bg-emerald-500'
                                      : step === 2
                                      ? 'w-2/3 bg-amber-400'
                                      : 'w-1/3 bg-blue-500'
                                  }`}
                                />
                              </div>
                            </div>

                            {task.adminComment && (
                              <div className="bg-emerald-50/70 border border-emerald-200 text-emerald-900 text-xs p-3 rounded-xl">
                                <span className="font-bold block mb-0.5">
                                  💬 最新の返信メモ：
                                </span>
                                {task.adminComment}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )}

            {mypageView === 'assigned' && (
              <div className="bg-white rounded-3xl shadow-sm border border-slate-200/80 p-6">
                {myAssignedDepts.length === 0 ? (
                  <div className="text-center py-12 space-y-3">
                    <p className="text-3xl">🏢</p>
                    <p className="font-bold text-slate-800">
                      あなたのメールアドレス（{user.email}）に紐づく部署がまだありません
                    </p>
                    <p className="text-xs text-slate-500">
                      「部署・メール管理」から自分のアドレスを担当部署（複数兼任OK）に登録すると、ここに自動で一覧表示されます。
                    </p>
                    <button
                      onClick={() => {
                        setActiveTab('admin');
                        setAdminView('departments');
                        if (user.email) syncBulkSelectionForEmail(user.email);
                      }}
                      className="bg-blue-600 text-white text-xs font-bold px-5 py-2.5 rounded-xl shadow-sm"
                    >
                      担当部署を登録しに行く →
                    </button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {myAssignedDepts.length > 1 && (
                      <div className="flex flex-wrap items-center gap-2 pb-2 border-b border-slate-100">
                        <span className="text-xs font-bold text-slate-400">兼任部署の絞り込み：</span>
                        <button
                          onClick={() => setMyDeptFilter('すべて')}
                          className={`text-xs font-bold px-3 py-1.5 rounded-full ${
                            myDeptFilter === 'すべて'
                              ? 'bg-blue-600 text-white'
                              : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          担当すべて（{allAssignedTasks.length}）
                        </button>
                        {myAssignedDepts.map((d) => {
                          const cnt = allAssignedTasks.filter((t) =>
                            getTaskDepts(t).includes(d.name)
                          ).length;
                          return (
                            <button
                              key={d.id}
                              onClick={() => setMyDeptFilter(d.name)}
                              className={`text-xs font-bold px-3 py-1.5 rounded-full ${
                                myDeptFilter === d.name
                                  ? 'bg-blue-600 text-white'
                                  : 'bg-slate-100 text-slate-600'
                              }`}
                            >
                              {d.name}（{cnt}）
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {displayedAssignedTasks.length === 0 ? (
                      <p className="text-center text-sm text-slate-400 py-10">
                        {mypageSearchQuery
                          ? `「${mypageSearchQuery}」に一致する依頼はありません`
                          : '現在届いている依頼はありません'}
                      </p>
                    ) : (
                      displayedAssignedTasks.map((task) => {
                        const isUrgent = task.priority === '急ぎ';
                        const taskDepts = getTaskDepts(task);
                        return (
                          <div
                            key={task.id}
                            onClick={() => openTaskModal(task)}
                            className={`cursor-pointer p-5 border rounded-2xl hover:border-blue-300 hover:bg-blue-50/20 flex flex-col gap-3 transition-all ${
                              isUrgent && task.status !== '完了'
                                ? 'border-rose-300 bg-rose-50/20'
                                : 'border-slate-200'
                            }`}
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="flex flex-wrap items-center gap-1.5">
                                {isUrgent && (
                                  <span className="text-[11px] font-extrabold bg-rose-100 text-rose-700 border border-rose-200 px-2.5 py-0.5 rounded-full">
                                    🔥 急ぎ
                                  </span>
                                )}
                                <span
                                  className={`text-xs font-bold px-2.5 py-1 rounded-full ${
                                    task.status === '完了'
                                      ? 'bg-emerald-100 text-emerald-700'
                                      : task.status === '対応中'
                                      ? 'bg-amber-100 text-amber-700'
                                      : 'bg-blue-100 text-blue-700'
                                  }`}
                                >
                                  {task.status}
                                </span>
                                {taskDepts.map((dName) => (
                                  <span
                                    key={dName}
                                    className="text-xs font-bold bg-indigo-50 text-indigo-700 px-2.5 py-1 rounded-full"
                                  >
                                    {dName}
                                  </span>
                                ))}
                                <span className="text-xs text-slate-500">
                                  依頼者：{task.creatorName || '社員'}
                                  {task.creatorEmail ? ` (${task.creatorEmail})` : ''}
                                </span>
                              </div>
                              <div className="flex items-center gap-3">
                                <span className="text-xs text-slate-400">
                                  {formatTimestamp(task.createdAt)}
                                </span>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDeleteTask(task);
                                  }}
                                  className="text-xs text-red-500 hover:bg-red-50 font-bold px-2.5 py-1 rounded-lg transition-colors"
                                  title="このタスクを削除"
                                >
                                  削除
                                </button>
                              </div>
                            </div>

                            <div>
                              <h4 className="font-bold text-slate-900">{task.title}</h4>
                              <p className="text-xs text-slate-600 mt-1">{task.detail}</p>
                            </div>

                            {task.status !== '完了' && (
                              <div
                                onClick={(e) => e.stopPropagation()}
                                className="flex flex-col sm:flex-row gap-2 pt-2 border-t border-slate-100"
                              >
                                <input
                                  type="text"
                                  placeholder="返信メモ（依頼者・担当部長へメール通知されます）"
                                  value={commentDrafts[task.id] || ''}
                                  onChange={(e) =>
                                    setCommentDrafts((prev) => ({
                                      ...prev,
                                      [task.id]: e.target.value,
                                    }))
                                  }
                                  className="flex-1 text-xs border border-slate-200 rounded-xl px-3 py-2 outline-none focus:border-blue-500 bg-white"
                                />
                                <button
                                  onClick={() =>
                                    handleStatusChange(
                                      task,
                                      task.status === '未処理' ? '対応中' : '完了'
                                    )
                                  }
                                  className={`text-xs font-bold text-white px-4 py-2 rounded-xl shrink-0 ${
                                    task.status === '未処理'
                                      ? 'bg-blue-600 hover:bg-blue-700'
                                      : 'bg-emerald-600 hover:bg-emerald-700'
                                  }`}
                                >
                                  {task.status === '未処理' ? '対応中にする →' : '完了にする ✓'}
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* =========================================
            【3】全体管理
        ========================================= */}
        {activeTab === 'admin' && (
          <div className="max-w-7xl mx-auto">
            <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
              <div className="flex flex-wrap gap-1.5 bg-white p-1.5 rounded-2xl border border-slate-200">
                <button
                  onClick={() => setAdminView('board')}
                  className={`px-4 py-2 rounded-xl text-xs md:text-sm font-bold transition-all ${
                    adminView === 'board'
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  📋 手伝えるかもボード
                </button>
                <button
                  onClick={() => setAdminView('analytics')}
                  className={`px-4 py-2 rounded-xl text-xs md:text-sm font-bold transition-all ${
                    adminView === 'analytics'
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  📊 分析ダッシュボード
                </button>
                <button
                  onClick={() => setAdminView('departments')}
                  className={`px-4 py-2 rounded-xl text-xs md:text-sm font-bold transition-all ${
                    adminView === 'departments'
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  🏢 部署・メール管理
                </button>
              </div>

              {adminView === 'board' && (
                <div className="flex flex-wrap items-center gap-2">
                  {/* キーワード検索窓 */}
                  <div className="relative w-64 sm:w-72">
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-xs">
                      🔍
                    </span>
                    <input
                      type="text"
                      value={boardSearchQuery}
                      onChange={(e) => setBoardSearchQuery(e.target.value)}
                      placeholder="過去の相談を検索（例：VPN 契約書）"
                      className="w-full bg-white border border-slate-200 rounded-xl pl-9 pr-8 py-2 text-xs outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    {boardSearchQuery && (
                      <button
                        onClick={() => setBoardSearchQuery('')}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 text-xs font-bold"
                      >
                        ✕
                      </button>
                    )}
                  </div>

                  {/* 急ぎのみ絞り込みボタン */}
                  <button
                    onClick={() => setBoardUrgentOnly((prev) => !prev)}
                    className={`text-xs font-bold px-3.5 py-2 rounded-xl border transition-all ${
                      boardUrgentOnly
                        ? 'bg-rose-600 text-white border-rose-600 shadow-xs'
                        : 'bg-white text-rose-600 border-rose-200 hover:bg-rose-50'
                    }`}
                  >
                    🔥 急ぎのみ {boardUrgentOnly ? 'ON' : ''}
                  </button>
                </div>
              )}
            </div>

            {/* 部署絞り込みバー */}
            {adminView === 'board' && (
              <div className="flex flex-wrap items-center justify-between gap-2 mb-6">
                <div className="flex items-center gap-2 overflow-x-auto pb-1">
                  <span className="text-xs font-bold text-slate-400 shrink-0">部署絞り込み：</span>
                  <button
                    onClick={() => setDeptFilter('すべて')}
                    className={`text-xs font-bold px-3 py-1.5 rounded-full transition-colors shrink-0 ${
                      deptFilter === 'すべて'
                        ? 'bg-blue-600 text-white'
                        : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    すべて
                  </button>
                  {departments.map((d) => (
                    <button
                      key={d.id}
                      onClick={() => setDeptFilter(d.name)}
                      className={`text-xs font-bold px-3 py-1.5 rounded-full transition-colors shrink-0 ${
                        deptFilter === d.name
                          ? 'bg-blue-600 text-white'
                          : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      {d.name}
                    </button>
                  ))}
                </div>

                {(boardSearchQuery || boardUrgentOnly || deptFilter !== 'すべて') && (
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <span>表示中：{filteredBoardTasks.length}件</span>
                    <button
                      onClick={() => {
                        setBoardSearchQuery('');
                        setBoardUrgentOnly(false);
                        setDeptFilter('すべて');
                      }}
                      className="text-blue-600 font-bold hover:underline"
                    >
                      条件リセット
                    </button>
                  </div>
                )}
              </div>
            )}

            {adminView === 'board' && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {statusConfig.map((col) => {
                  const colTasks = filteredBoardTasks
                    .filter((t) => t.status === col.key)
                    .sort((a, b) => Number(b.priority === '急ぎ') - Number(a.priority === '急ぎ'));
                  return (
                    <div
                      key={col.key}
                      className={`${col.columnBg} rounded-3xl p-4 border border-slate-200/80 min-h-[600px]`}
                    >
                      <div className="flex items-center justify-between mb-4 px-1">
                        <h3 className="font-bold text-slate-800 flex items-center gap-2">
                          <span className={`w-2.5 h-2.5 rounded-full ${col.dot}`}></span>
                          {col.label}
                        </h3>
                        <span className={`${col.badge} text-xs font-bold px-2.5 py-0.5 rounded-full`}>
                          {colTasks.length}件
                        </span>
                      </div>

                      <div className="space-y-3">
                        {colTasks.length === 0 ? (
                          <div className="h-28 border-2 border-dashed border-slate-200/80 rounded-2xl flex items-center justify-center text-slate-400 text-xs">
                            該当するタスクはありません
                          </div>
                        ) : (
                          colTasks.map((task) => {
                            const logCount = task.history?.length || 0;
                            const isUrgent = task.priority === '急ぎ';
                            const taskDepts = getTaskDepts(task);
                            return (
                              <div
                                key={task.id}
                                onClick={() => openTaskModal(task)}
                                className={`cursor-pointer bg-white p-5 rounded-2xl shadow-sm border transition-all hover:shadow-md hover:border-blue-300 ${
                                  col.key === '完了'
                                    ? 'opacity-75 border-slate-200/80'
                                    : isUrgent
                                    ? 'border-rose-300 ring-1 ring-rose-100'
                                    : 'border-slate-200/80'
                                }`}
                              >
                                <div className="flex items-start justify-between gap-2 mb-2.5">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    {isUrgent && (
                                      <span className="bg-rose-100 text-rose-700 border border-rose-200 text-[10px] font-extrabold px-2 py-0.5 rounded-full">
                                        🔥 急ぎ
                                      </span>
                                    )}
                                    {taskDepts.map((dName) => (
                                      <span
                                        key={dName}
                                        className="bg-blue-50 text-blue-700 border border-blue-100 text-[11px] font-bold px-2.5 py-0.5 rounded-full"
                                      >
                                        🤖 {dName}
                                      </span>
                                    ))}
                                  </div>
                                  <div className="flex items-center gap-2 shrink-0">
                                    <span className="text-[11px] text-slate-400">
                                      {formatTimestamp(task.createdAt)}
                                    </span>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleDeleteTask(task);
                                      }}
                                      className="text-[11px] text-red-400 hover:text-red-600 hover:bg-red-50 font-bold px-1.5 py-0.5 rounded transition-colors"
                                      title="カードを削除"
                                    >
                                      ✕
                                    </button>
                                  </div>
                                </div>

                                <h4
                                  className={`font-bold text-slate-900 mb-1.5 ${
                                    col.key === '完了' ? 'line-through text-slate-500' : ''
                                  }`}
                                >
                                  {task.title}
                                </h4>
                                <p className="text-xs text-slate-500 leading-relaxed mb-3">
                                  {task.detail}
                                </p>

                                {task.adminComment && (
                                  <p className="text-[11px] bg-emerald-50 text-emerald-800 p-2 rounded-lg mb-3">
                                    💬 {task.adminComment}
                                  </p>
                                )}

                                {col.key !== '完了' && (
                                  <input
                                    type="text"
                                    placeholder="返信メモ（依頼者・担当部長へメール通知）"
                                    value={commentDrafts[task.id] || ''}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) =>
                                      setCommentDrafts((prev) => ({
                                        ...prev,
                                        [task.id]: e.target.value,
                                      }))
                                    }
                                    className="w-full text-xs bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 mb-3 outline-none focus:bg-white focus:border-blue-400"
                                  />
                                )}

                                <div className="flex items-center justify-between pt-3 border-t border-slate-100">
                                  <div className="flex items-center gap-2">
                                    {task.creatorPhoto ? (
                                      <img
                                        src={task.creatorPhoto}
                                        alt=""
                                        className="w-5 h-5 rounded-full"
                                      />
                                    ) : (
                                      <div className="w-5 h-5 rounded-full bg-slate-200 text-[10px] flex items-center justify-center font-bold text-slate-600">
                                        {(task.creatorName || '社')[0]}
                                      </div>
                                    )}
                                    <span className="text-[11px] text-slate-500 font-medium">
                                      {task.creatorName || '社員'}
                                    </span>
                                    {logCount > 0 && (
                                      <span className="text-[10px] font-bold text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">
                                        💬 {logCount}
                                      </span>
                                    )}
                                  </div>

                                  <div
                                    onClick={(e) => e.stopPropagation()}
                                    className="flex items-center gap-1.5"
                                  >
                                    {col.key !== '未処理' && (
                                      <button
                                        onClick={() =>
                                          handleStatusChange(
                                            task,
                                            col.key === '完了' ? '対応中' : '未処理'
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
                                          handleStatusChange(
                                            task,
                                            col.key === '未処理' ? '対応中' : '完了'
                                          )
                                        }
                                        className={`text-xs font-bold text-white px-3 py-1.5 rounded-lg transition-colors ${
                                          col.key === '未処理'
                                            ? 'bg-blue-600 hover:bg-blue-700'
                                            : 'bg-emerald-600 hover:bg-emerald-700'
                                        }`}
                                      >
                                        {col.key === '未処理' ? '対応する →' : '完了にする ✓'}
                                      </button>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {adminView === 'analytics' && (
              <div className="space-y-6">
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="bg-white p-6 rounded-3xl border border-slate-200/80 shadow-sm">
                    <span className="text-xs font-bold text-slate-400">累計の相談件数</span>
                    <p className="text-3xl font-black text-slate-900 mt-2">
                      {totalCount}
                      <span className="text-xs font-normal text-slate-400 ml-1">件</span>
                    </p>
                  </div>
                  <div className="bg-white p-6 rounded-3xl border border-slate-200/80 shadow-sm">
                    <span className="text-xs font-bold text-slate-400">タスク解決率</span>
                    <p className="text-3xl font-black text-emerald-600 mt-2">
                      {completionRate}
                      <span className="text-sm font-bold ml-0.5">%</span>
                    </p>
                    <div className="w-full h-1.5 bg-slate-100 rounded-full mt-2 overflow-hidden">
                      <div
                        className="h-full bg-emerald-500"
                        style={{ width: `${completionRate}%` }}
                      />
                    </div>
                  </div>
                  <div className="bg-white p-6 rounded-3xl border border-slate-200/80 shadow-sm">
                    <span className="text-xs font-bold text-slate-400">現在アクティブ</span>
                    <p className="text-3xl font-black text-amber-500 mt-2">
                      {pendingCount + inProgressCount}
                      <span className="text-xs font-normal text-slate-400 ml-1">
                        件（急ぎ {urgentActiveCount}）
                      </span>
                    </p>
                  </div>
                  <div className="bg-white p-6 rounded-3xl border border-slate-200/80 shadow-sm">
                    <span className="text-xs font-bold text-slate-400">最多相談の窓口</span>
                    <p className="text-xl font-black text-blue-600 mt-3 truncate">{topDeptName}</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <div className="bg-white p-6 rounded-3xl border border-slate-200/80 shadow-sm">
                    <h3 className="font-bold text-slate-900 mb-1">📈 直近7日間の相談件数推移</h3>
                    <p className="text-xs text-slate-400 mb-6">日ごとの新規ヘルプデスク相談数</p>
                    <div className="h-48 flex items-end justify-between gap-3 pt-6 px-2 border-b border-slate-100">
                      {dailyStats.map((d, i) => {
                        const heightPct = Math.round((d.count / maxDailyCount) * 100);
                        return (
                          <div
                            key={i}
                            className="flex-1 flex flex-col items-center gap-2 h-full justify-end"
                          >
                            <span className="text-xs font-bold text-slate-600">{d.count}</span>
                            <div
                              className="w-full max-w-[36px] bg-gradient-to-t from-blue-600 to-indigo-400 rounded-t-xl transition-all duration-500"
                              style={{ height: `${Math.max(heightPct, d.count > 0 ? 12 : 4)}%` }}
                            />
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex justify-between gap-3 pt-2 px-2">
                      {dailyStats.map((d, i) => (
                        <span
                          key={i}
                          className="flex-1 text-center text-[11px] text-slate-400 font-medium"
                        >
                          {d.label}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="bg-white p-6 rounded-3xl border border-slate-200/80 shadow-sm">
                    <h3 className="font-bold text-slate-900 mb-1">
                      🏢 部署別の相談件数・ステータス内訳
                    </h3>
                    <p className="text-xs text-slate-400 mb-5">
                      青＝未処理 / 黄＝対応中 / 緑＝完了（複数部署連携タスクは各部署に計上）
                    </p>
                    {deptStats.length === 0 ? (
                      <p className="text-sm text-slate-400 py-10 text-center">データがありません</p>
                    ) : (
                      <div className="space-y-4">
                        {deptStats.map((d) => {
                          const widthPct = Math.round((d.total / maxDeptCount) * 100);
                          return (
                            <div key={d.name}>
                              <div className="flex justify-between text-xs mb-1">
                                <span className="font-bold text-slate-700">{d.name}</span>
                                <span className="text-slate-500 font-medium">
                                  計 {d.total}件（完了 {d.completed}）
                                </span>
                              </div>
                              <div className="w-full h-3 bg-slate-100 rounded-full overflow-hidden">
                                {d.total > 0 && (
                                  <div
                                    className="h-full flex rounded-full overflow-hidden"
                                    style={{ width: `${Math.max(widthPct, 8)}%` }}
                                  >
                                    <div
                                      style={{ width: `${(d.pending / d.total) * 100}%` }}
                                      className="bg-blue-500"
                                    />
                                    <div
                                      style={{ width: `${(d.inProgress / d.total) * 100}%` }}
                                      className="bg-amber-400"
                                    />
                                    <div
                                      style={{ width: `${(d.completed / d.total) * 100}%` }}
                                      className="bg-emerald-500"
                                    />
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>

                <div className="bg-white p-6 rounded-3xl border border-slate-200/80 shadow-sm">
                  <h3 className="font-bold text-slate-900 mb-3">🏷️ よく相談されているキーワード</h3>
                  {topTags.length === 0 ? (
                    <p className="text-xs text-slate-400">
                      相談データが貯まると自動でキーワード集計が表示されます。
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {topTags.map(([tag, count]) => (
                        <span
                          key={tag}
                          className="bg-slate-100 text-slate-700 text-xs font-bold px-3 py-1.5 rounded-full flex items-center gap-1.5"
                        >
                          #{tag}
                          <span className="bg-blue-600 text-white text-[10px] px-1.5 py-0.5 rounded-full">
                            {count}
                          </span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {adminView === 'departments' && (
              <div className="space-y-6 max-w-5xl">
                <div className="bg-white p-6 md:p-7 rounded-3xl shadow-sm border border-indigo-200/80">
                  <h3 className="font-bold text-base text-slate-900 mb-1">
                    👤 兼任・担当部署のまとめ設定（1つのメールアドレスに複数部署を紐づけ）
                  </h3>
                  <p className="text-xs text-slate-500 mb-4">
                    部長のメールアドレスを入力し、担当する部署すべてにチェックを入れて保存できます（何個でも兼任OK）。
                  </p>

                  <div className="flex flex-col sm:flex-row gap-2.5 mb-4">
                    <input
                      type="email"
                      placeholder="部長のメールアドレス（例：bucho@company.co.jp）"
                      value={bulkEmail}
                      onChange={(e) => syncBulkSelectionForEmail(e.target.value)}
                      className="flex-1 border border-slate-200 px-4 py-2.5 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                    />
                    {user.email && (
                      <button
                        onClick={() => syncBulkSelectionForEmail(user.email || '')}
                        className="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold px-4 py-2.5 rounded-xl text-xs shrink-0"
                      >
                        自分のアドレス（{user.email}）を入れる
                      </button>
                    )}
                  </div>

                  {departments.length > 0 && (
                    <div className="flex flex-wrap gap-2.5 mb-5">
                      {departments.map((dept) => {
                        const checked = bulkDeptIds.includes(dept.id);
                        return (
                          <label
                            key={dept.id}
                            onClick={() => toggleBulkDept(dept.id)}
                            className={`cursor-pointer select-none px-4 py-2 rounded-xl border text-xs font-bold flex items-center gap-2 transition-all ${
                              checked
                                ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                                : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                            }`}
                          >
                            <span>{checked ? '☑' : '☐'}</span>
                            {dept.name}
                          </label>
                        );
                      })}
                    </div>
                  )}

                  <button
                    onClick={handleSaveBulkAssignment}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-6 py-2.5 rounded-xl text-xs shadow-sm"
                  >
                    ✓ チェックした部署にこのメールアドレスを紐づける
                  </button>
                </div>

                <div className="bg-white p-6 md:p-7 rounded-3xl shadow-sm border border-slate-200/80">
                  <h3 className="font-bold text-base text-slate-900 mb-1">新規部署の追加</h3>
                  <p className="text-xs text-slate-500 mb-4">
                    新しい部署を作る際も、そのまま担当部長のメールアドレスをセットできます。
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
                    <input
                      type="text"
                      placeholder="部署名（例：情報システム部）"
                      value={newDeptName}
                      onChange={(e) => setNewDeptName(e.target.value)}
                      className="border border-slate-200 px-4 py-2.5 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                    />
                    <input
                      type="email"
                      placeholder="担当部長メール（任意・カンマ区切りで複数可）"
                      value={newDeptEmail}
                      onChange={(e) => setNewDeptEmail(e.target.value)}
                      className="border border-slate-200 px-4 py-2.5 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                    />
                    <input
                      type="text"
                      placeholder="得意分野（例：PC修理、Wi-Fi、アカウント）"
                      value={newDeptExpertise}
                      onChange={(e) => setNewDeptExpertise(e.target.value)}
                      className="border border-slate-200 px-4 py-2.5 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                    />
                  </div>
                  <button
                    onClick={handleAddDepartment}
                    className="bg-blue-600 hover:bg-blue-700 text-white font-bold px-6 py-2.5 rounded-xl text-xs mb-8"
                  >
                    ＋ 部署を追加
                  </button>

                  <h3 className="font-bold text-slate-800 mb-4">
                    登録済みの部署・得意分野・担当部長メール一覧（{departments.length}件）
                  </h3>
                  <div className="space-y-4">
                    {departments.map((dept) => {
                      const expertiseVal = deptExpertiseDrafts[dept.id] ?? dept.expertise;
                      const emailVal = deptEmailDrafts[dept.id] ?? dept.managerEmail ?? '';
                      const isDirty =
                        expertiseVal !== dept.expertise ||
                        emailVal !== (dept.managerEmail ?? '');

                      return (
                        <div
                          key={dept.id}
                          className="p-4 md:p-5 border border-slate-200/80 bg-slate-50/70 rounded-2xl space-y-3"
                        >
                          <div className="flex items-center justify-between gap-4">
                            <span className="font-bold text-blue-700 text-sm flex items-center gap-1.5">
                              🏢 {dept.name}
                            </span>
                            <button
                              onClick={async () => {
                                if (confirm(`「${dept.name}」を削除しますか？`)) {
                                  await deleteDoc(doc(db, 'departments', dept.id));
                                }
                              }}
                              className="text-red-500 hover:bg-red-100 text-xs font-bold bg-red-50 px-3 py-1.5 rounded-lg shrink-0"
                            >
                              削除
                            </button>
                          </div>

                          <div className="space-y-1">
                            <label className="text-[11px] font-bold text-slate-500 block">
                              💡 得意分野・キーワード（AI判定・バックアップ振り分けに使用）
                            </label>
                            <textarea
                              rows={2}
                              placeholder="例：PC修理、VPN、Wi-Fi、アカウント発行、パスワードリセット"
                              value={expertiseVal}
                              onChange={(e) =>
                                setDeptExpertiseDrafts((prev) => ({
                                  ...prev,
                                  [dept.id]: e.target.value,
                                }))
                              }
                              className="w-full bg-white border border-slate-200 px-3 py-2 rounded-xl text-xs leading-relaxed outline-none focus:border-blue-500 resize-y"
                            />
                          </div>

                          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 pt-1">
                            <span className="text-xs font-bold text-slate-500 shrink-0">
                              📧 担当部長メール：
                            </span>
                            <input
                              type="text"
                              placeholder="未設定（例: bucho@company.co.jp）"
                              value={emailVal}
                              onChange={(e) =>
                                setDeptEmailDrafts((prev) => ({
                                  ...prev,
                                  [dept.id]: e.target.value,
                                }))
                              }
                              className="flex-1 bg-white border border-slate-200 px-3 py-2 rounded-xl text-xs outline-none focus:border-blue-500"
                            />
                            <button
                              onClick={() => handleSaveDeptDetails(dept)}
                              className={`text-xs font-bold px-4 py-2 rounded-xl shrink-0 transition-colors ${
                                isDirty
                                  ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-sm'
                                  : 'bg-slate-800 hover:bg-slate-900 text-white'
                              }`}
                            >
                              {isDirty ? '変更を保存' : '保存済み'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* =========================================
          【4】カード詳細・優先度・複数部署変更・コメント履歴モーダル
      ========================================= */}
      {selectedTask && (
        <div
          onClick={() => {
            setSelectedTaskId(null);
            setModalCommentText('');
          }}
          className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs z-50 flex items-center justify-center p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white rounded-3xl shadow-2xl border border-slate-200 max-w-2xl w-full max-h-[88vh] flex flex-col overflow-hidden"
          >
            {/* モーダルヘッダー */}
            <div className="px-6 py-4 bg-slate-50 border-b border-slate-200/80 flex items-start justify-between gap-4">
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  {selectedTask.priority === '急ぎ' && (
                    <span className="text-xs font-extrabold bg-rose-100 text-rose-700 border border-rose-200 px-2.5 py-0.5 rounded-full">
                      🔥 急ぎ
                    </span>
                  )}
                  <span
                    className={`text-xs font-bold px-2.5 py-0.5 rounded-full ${
                      selectedTask.status === '完了'
                        ? 'bg-emerald-100 text-emerald-700'
                        : selectedTask.status === '対応中'
                        ? 'bg-amber-100 text-amber-700'
                        : 'bg-blue-100 text-blue-700'
                    }`}
                  >
                    {selectedTask.status}
                  </span>
                  {selectedTaskDepts.map((dName) => (
                    <span
                      key={dName}
                      className="text-xs font-bold bg-blue-50 text-blue-700 border border-blue-100 px-2.5 py-0.5 rounded-full"
                    >
                      🤖 {dName}
                    </span>
                  ))}
                  <span className="text-xs text-slate-400">
                    {formatTimestamp(selectedTask.createdAt)}
                  </span>
                </div>
                <h3 className="text-lg font-black text-slate-900">{selectedTask.title}</h3>
              </div>
              <button
                onClick={() => {
                  setSelectedTaskId(null);
                  setModalCommentText('');
                }}
                className="text-slate-400 hover:text-slate-700 bg-white border border-slate-200 w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0"
              >
                ✕
              </button>
            </div>

            {/* モーダル本文 */}
            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              <div className="bg-slate-50/90 p-4 rounded-2xl border border-slate-200/70 space-y-2">
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span>
                    依頼者：<strong>{selectedTask.creatorName || '社員'}</strong>
                    {selectedTask.creatorEmail ? ` (${selectedTask.creatorEmail})` : ''}
                  </span>
                </div>
                <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
                  {selectedTask.detail}
                </p>
                {selectedTask.aiReason && (
                  <p className="text-xs text-blue-700 bg-blue-50/80 p-2.5 rounded-xl">
                    💡 {selectedTask.aiReason}
                  </p>
                )}
              </div>

              {/* ステータス ＆ 優先度コントロール */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="bg-white p-3.5 rounded-2xl border border-slate-200 flex flex-col gap-2">
                  <span className="text-xs font-bold text-slate-600">ステータス変更</span>
                  <div className="flex flex-wrap gap-1.5">
                    {(['未処理', '対応中', '完了'] as const).map((st) => {
                      const active = selectedTask.status === st;
                      return (
                        <button
                          key={st}
                          onClick={() => handleStatusChange(selectedTask, st)}
                          className={`text-xs font-bold px-3 py-1.5 rounded-xl transition-all ${
                            active
                              ? 'bg-slate-900 text-white shadow-xs'
                              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                          }`}
                        >
                          {st}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="bg-white p-3.5 rounded-2xl border border-slate-200 flex flex-col gap-2">
                  <span className="text-xs font-bold text-slate-600">優先度</span>
                  <div className="flex gap-1.5">
                    {(['通常', '急ぎ'] as const).map((p) => {
                      const currentP: TaskPriority =
                        selectedTask.priority === '急ぎ' ? '急ぎ' : '通常';
                      const active = currentP === p;
                      return (
                        <button
                          key={p}
                          onClick={() => handlePriorityChange(selectedTask, p)}
                          className={`text-xs font-bold px-3.5 py-1.5 rounded-xl transition-all ${
                            active
                              ? p === '急ぎ'
                                ? 'bg-rose-600 text-white shadow-xs'
                                : 'bg-slate-900 text-white shadow-xs'
                              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                          }`}
                        >
                          {p === '急ぎ' ? '🔥 急ぎ' : '通常'}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* 担当部署の変更・複数追加バー */}
              {modalSelectableDeptNames.length > 0 && (
                <div className="bg-indigo-50/50 p-4 rounded-2xl border border-indigo-200/80 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-indigo-900">
                      🔀 担当部署の変更・複数追加（{editTaskDepts.length}部署選択中）
                    </span>
                    <button
                      onClick={() => handleUpdateTaskDepartments(selectedTask)}
                      disabled={
                        isUpdatingDepts ||
                        editTaskDepts.length === 0 ||
                        isSameDeptSet(selectedTaskDepts, editTaskDepts)
                      }
                      className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white text-xs font-bold px-4 py-1.5 rounded-xl shrink-0 transition-colors"
                    >
                      {isUpdatingDepts ? '更新中...' : '担当部署を更新'}
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {modalSelectableDeptNames.map((deptName) => {
                      const checked = editTaskDepts.includes(deptName);
                      return (
                        <button
                          key={deptName}
                          type="button"
                          onClick={() => handleToggleModalDept(deptName)}
                          className={`text-xs font-bold px-3 py-1.5 rounded-xl border transition-all flex items-center gap-1.5 ${
                            checked
                              ? 'bg-indigo-600 text-white border-indigo-600 shadow-2xs'
                              : 'bg-white text-slate-700 border-indigo-200 hover:bg-indigo-50'
                          }`}
                        >
                          <span>{checked ? '☑' : '☐'}</span>
                          {deptName}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* コメント・対応履歴タイムライン */}
              <div className="space-y-3">
                <h4 className="text-sm font-bold text-slate-800 flex items-center gap-1.5">
                  🕒 コメント・対応履歴（{modalHistoryList.length}件）
                </h4>

                <div className="space-y-2.5">
                  {modalHistoryList.map((item) => (
                    <div
                      key={item.id}
                      className={`p-3.5 rounded-2xl border text-xs ${
                        item.type === 'transfer'
                          ? 'bg-purple-50/60 border-purple-200 text-slate-700'
                          : item.type === 'priority'
                          ? 'bg-rose-50/50 border-rose-200 text-slate-700'
                          : item.type === 'status'
                          ? 'bg-indigo-50/50 border-indigo-100 text-slate-700'
                          : 'bg-white border-slate-200/80 text-slate-800 shadow-2xs'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="font-bold text-slate-800">
                          {item.type === 'transfer'
                            ? '🔀 '
                            : item.type === 'priority'
                            ? '🔥 '
                            : item.type === 'status'
                            ? '🔄 '
                            : '💬 '}
                          {item.actorName}
                        </span>
                        <span className="text-[10px] text-slate-400">{item.createdAtLabel}</span>
                      </div>
                      <p className="leading-relaxed whitespace-pre-wrap">{item.text}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* コメント入力フッター */}
            <div className="p-4 bg-slate-50 border-t border-slate-200/80">
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="コメントを入力（依頼者・担当部長へメール通知されます）..."
                  value={modalCommentText}
                  onChange={(e) => setModalCommentText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      handleAddModalComment(selectedTask);
                    }
                  }}
                  className="flex-1 bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  onClick={() => handleAddModalComment(selectedTask)}
                  disabled={isPostingComment || !modalCommentText.trim()}
                  className="bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white font-bold px-5 py-2.5 rounded-xl text-sm shrink-0"
                >
                  {isPostingComment ? '送信中...' : '投稿'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
