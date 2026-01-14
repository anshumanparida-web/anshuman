
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage, Blob, Type } from '@google/genai';
import { Phone, PhoneOff, Settings, Package, Tag, MapPin, User, MessageSquare, IndianRupee, FileUp, FileText, Loader2, Download, CheckCircle2, XCircle, Clock } from 'lucide-react';
import { CallStatus, ProductOffer, TranscriptionEntry, Lead } from './types';
import { encode, decode, decodeAudioData } from './utils/audio';
import AudioVisualizer from './components/AudioVisualizer';
import * as pdfjs from 'pdfjs-dist';
import { jsPDF } from 'jspdf';
import 'jspdf-autotable';

// Initialize PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `https://esm.sh/pdfjs-dist@4.0.379/build/pdf.worker.mjs`;

const SAMPLE_RATE_OUT = 24000;
const SAMPLE_RATE_IN = 16000;

const App: React.FC = () => {
  // State
  const [status, setStatus] = useState<CallStatus>(CallStatus.IDLE);
  const [product, setProduct] = useState<ProductOffer>({
    name: 'Bharat Fresh Organic Tea',
    description: 'Premium hand-picked tea from Assam gardens.',
    price: '499',
    offer: 'Buy 1 Get 1 Free',
    targetCity: 'Mumbai'
  });
  const [leads, setLeads] = useState<Lead[]>([]);
  const [currentLeadIndex, setCurrentLeadIndex] = useState<number | null>(null);
  const [isProcessingPdf, setIsProcessingPdf] = useState(false);
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);

  // Refs for Audio API
  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const activeSessionRef = useRef<any>(null);
  const transcriptionBufferIn = useRef('');
  const transcriptionBufferOut = useRef('');

  const currentLead = currentLeadIndex !== null ? leads[currentLeadIndex] : null;

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsProcessingPdf(true);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
      let fullText = '';
      
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        fullText += textContent.items.map((item: any) => item.str).join(' ');
      }

      await extractLeads(fullText);
    } catch (error) {
      console.error('PDF Processing Error:', error);
      alert('Failed to process PDF. Please ensure it is a valid text-based PDF.');
    } finally {
      setIsProcessingPdf(false);
    }
  };

  const extractLeads = async (text: string) => {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Extract a list of customers/leads from this text. Return a JSON array of objects with fields: name, city, phone (if any), and notes. Text: ${text}`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              city: { type: Type.STRING },
              phone: { type: Type.STRING },
              notes: { type: Type.STRING },
            },
            required: ["name", "city"],
          }
        }
      }
    });

    try {
      const extractedLeads = JSON.parse(response.text || '[]').map((l: any, idx: number) => ({
        ...l,
        id: `lead-${Date.now()}-${idx}`,
        status: 'pending'
      }));
      setLeads(extractedLeads);
    } catch (e) {
      console.error('Failed to parse leads JSON', e);
    }
  };

  const updateLeadStatus = (id: string, updates: Partial<Lead>) => {
    setLeads(prevLeads => prevLeads.map(lead => lead.id === id ? { ...lead, ...updates } : lead));
  };

  const stopCall = useCallback(() => {
    if (activeSessionRef.current) {
      activeSessionRef.current.close();
      activeSessionRef.current = null;
    }
    
    sourcesRef.current.forEach(source => source.stop());
    sourcesRef.current.clear();
    
    if (micStream) {
      micStream.getTracks().forEach(track => track.stop());
      setMicStream(null);
    }

    if (audioContextInRef.current) audioContextInRef.current.close();
    if (audioContextOutRef.current) audioContextOutRef.current.close();
    
    // Save final summary if active
    if (currentLead && transcriptionBufferOut.current) {
        updateLeadStatus(currentLead.id, { 
            status: 'called', 
            summary: transcriptionBufferOut.current.slice(0, 200) + '...' 
        });
    }

    setStatus(CallStatus.ENDED);
    setTimeout(() => setStatus(CallStatus.IDLE), 2000);
  }, [micStream, currentLead]);

  const startCall = async (index: number) => {
    const lead = leads[index];
    if (!lead) return;

    setCurrentLeadIndex(index);
    try {
      setStatus(CallStatus.DIALING);
      setTranscriptions([]);
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setMicStream(stream);

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      const systemInstruction = `
        You are 'Arjun', a polite and persuasive sales representative for a premium Indian brand.
        You are calling ${lead.name} who lives in ${lead.city}.
        
        Product: ${product.name}
        Description: ${product.description}
        Price: ₹${product.price}
        Current Offer: ${product.offer}
        Lead Notes: ${lead.notes || 'No specific notes'}
        
        Guidelines:
        1. Start naturally: "Namaste ${lead.name}, I hope you are doing well. This is Arjun from Bharat Brands."
        2. Speak in a friendly, professional tone using Hinglish (Hindi + English).
        3. Explain the benefits of ${product.name} and the ${product.offer} deal.
        4. If interested, mark it verbally. If they decline, be extremely polite.
        5. Keep responses short and human.
      `;

      audioContextInRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: SAMPLE_RATE_IN });
      audioContextOutRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: SAMPLE_RATE_OUT });

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus(CallStatus.ACTIVE);
            const source = audioContextInRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = audioContextInRef.current!.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              if (status === CallStatus.ACTIVE || status === CallStatus.DIALING) {
                const inputData = e.inputBuffer.getChannelData(0);
                const int16 = new Int16Array(inputData.length);
                for (let i = 0; i < inputData.length; i++) int16[i] = inputData[i] * 32768;
                const pcmBlob: Blob = {
                  data: encode(new Uint8Array(int16.buffer)),
                  mimeType: 'audio/pcm;rate=16000',
                };
                sessionPromise.then(session => session.sendRealtimeInput({ media: pcmBlob }));
              }
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextInRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.inputTranscription) transcriptionBufferIn.current += message.serverContent.inputTranscription.text;
            if (message.serverContent?.outputTranscription) transcriptionBufferOut.current += message.serverContent.outputTranscription.text;

            if (message.serverContent?.turnComplete) {
              if (transcriptionBufferIn.current) {
                setTranscriptions(prev => [...prev, { role: 'user', text: transcriptionBufferIn.current, timestamp: Date.now() }]);
                transcriptionBufferIn.current = '';
              }
              if (transcriptionBufferOut.current) {
                setTranscriptions(prev => [...prev, { role: 'agent', text: transcriptionBufferOut.current, timestamp: Date.now() }]);
                // Update lead summary in real-time
                updateLeadStatus(lead.id, { summary: transcriptionBufferOut.current });
                transcriptionBufferOut.current = '';
              }
            }

            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData) {
              const outCtx = audioContextOutRef.current!;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outCtx.currentTime);
              const buffer = await decodeAudioData(decode(audioData), outCtx, SAMPLE_RATE_OUT, 1);
              const source = outCtx.createBufferSource();
              source.buffer = buffer;
              source.connect(outCtx.destination);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              sourcesRef.current.add(source);
            }
          },
          onerror: stopCall,
          onclose: stopCall
        }
      });
      activeSessionRef.current = await sessionPromise;
    } catch (err) {
      console.error(err);
      setStatus(CallStatus.IDLE);
    }
  };

  const exportSummaryPdf = () => {
    const doc = new jsPDF();
    doc.setFontSize(20);
    doc.text('BharatAI Call Summary Report', 14, 22);
    doc.setFontSize(11);
    doc.setTextColor(100);
    doc.text(`Generated on: ${new Date().toLocaleString()}`, 14, 30);
    
    const tableData = leads.map(l => [
      l.name,
      l.city,
      l.status.toUpperCase().replace('_', ' '),
      l.summary || 'No conversation recorded'
    ]);

    (doc as any).autoTable({
      startY: 40,
      head: [['Customer', 'City', 'Status', 'Interaction Summary']],
      body: tableData,
      theme: 'grid',
      headStyles: { fillColor: [22, 163, 74] }
    });

    doc.save(`BharatAI_Report_${Date.now()}.pdf`);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center p-4 md:p-8">
      {/* Header */}
      <header className="w-full max-w-6xl mb-8 flex justify-between items-center bg-white p-4 rounded-2xl shadow-sm">
        <div className="flex items-center gap-3">
          <div className="bg-green-600 p-2 rounded-xl shadow-lg">
            <Phone className="text-white w-6 h-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-800">BharatAI Sales Caller</h1>
            <p className="text-slate-500 text-sm">Next-gen outbound lead management</p>
          </div>
        </div>
        <div className="flex gap-2">
            <label className="cursor-pointer bg-slate-100 hover:bg-slate-200 text-slate-700 px-4 py-2 rounded-lg flex items-center gap-2 transition-colors">
                <FileUp className="w-4 h-4" />
                <span>Upload PDF Leads</span>
                <input type="file" accept=".pdf" className="hidden" onChange={handleFileUpload} />
            </label>
            {leads.length > 0 && (
                <button 
                    onClick={exportSummaryPdf}
                    className="bg-green-100 hover:bg-green-200 text-green-700 px-4 py-2 rounded-lg flex items-center gap-2 transition-colors"
                >
                    <Download className="w-4 h-4" />
                    <span>Export Report</span>
                </button>
            )}
        </div>
      </header>

      <main className="w-full max-w-6xl grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Column: Lead Queue */}
        <div className="lg:col-span-4 space-y-6">
          <section className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 flex flex-col h-[700px]">
            <div className="flex justify-between items-center mb-4">
                <h2 className="text-lg font-semibold flex items-center gap-2">
                    <User className="w-5 h-5 text-green-600" /> Customer Queue
                </h2>
                <span className="bg-slate-100 text-slate-500 text-xs px-2 py-1 rounded-full font-medium">
                    {leads.filter(l => l.status !== 'pending').length} / {leads.length} Done
                </span>
            </div>

            {isProcessingPdf && (
                <div className="flex-1 flex flex-col items-center justify-center text-slate-500 gap-3">
                    <Loader2 className="w-8 h-8 animate-spin text-green-600" />
                    <p className="animate-pulse">Processing PDF Leads...</p>
                </div>
            )}

            {!isProcessingPdf && leads.length === 0 && (
                <div className="flex-1 flex flex-col items-center justify-center text-slate-400 text-center px-4">
                    <FileText className="w-12 h-12 mb-3 opacity-20" />
                    <p className="text-sm">Upload a PDF containing customer data to start the automated calling process.</p>
                </div>
            )}

            {!isProcessingPdf && leads.length > 0 && (
                <div className="flex-1 overflow-y-auto space-y-3 pr-2 custom-scrollbar">
                    {leads.map((lead, idx) => (
                        <div 
                            key={lead.id}
                            className={`p-4 rounded-xl border transition-all cursor-pointer ${
                                currentLeadIndex === idx ? 'border-green-500 bg-green-50 shadow-sm' : 'border-slate-100 bg-slate-50 hover:border-slate-300'
                            }`}
                            onClick={() => status === CallStatus.IDLE && setCurrentLeadIndex(idx)}
                        >
                            <div className="flex justify-between items-start mb-2">
                                <div>
                                    <h4 className="font-bold text-slate-800">{lead.name}</h4>
                                    <p className="text-xs text-slate-500 flex items-center gap-1">
                                        <MapPin className="w-3 h-3" /> {lead.city}
                                    </p>
                                </div>
                                {lead.status === 'pending' && <Clock className="w-4 h-4 text-slate-400" />}
                                {lead.status === 'called' && <CheckCircle2 className="w-4 h-4 text-green-500" />}
                            </div>
                            {lead.notes && (
                                <p className="text-xs text-slate-500 italic truncate">"{lead.notes}"</p>
                            )}
                            {currentLeadIndex === idx && status === CallStatus.IDLE && (
                                <button 
                                    onClick={() => startCall(idx)}
                                    className="mt-3 w-full bg-green-600 text-white text-xs py-2 rounded-lg font-bold flex items-center justify-center gap-2"
                                >
                                    <Phone className="w-3 h-3" /> Start Call
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            )}
          </section>
        </div>

        {/* Right Column: Active Call & Product Details */}
        <div className="lg:col-span-8 space-y-6 flex flex-col">
          {/* Active Call Section */}
          <div className="bg-white p-8 rounded-2xl shadow-lg border border-slate-100 flex flex-col items-center justify-center relative overflow-hidden">
            {status === CallStatus.ACTIVE && (
              <div className="absolute top-4 right-4 flex items-center gap-2">
                <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse"></span>
                <span className="text-xs font-bold text-slate-500 tracking-wider">LIVE CALL</span>
              </div>
            )}

            {currentLead ? (
                <>
                    <div className={`w-32 h-32 rounded-full flex items-center justify-center mb-6 transition-all duration-500 ${
                        status === CallStatus.ACTIVE ? 'bg-green-100 ring-8 ring-green-50' : 
                        status === CallStatus.DIALING ? 'bg-blue-100 ring-8 ring-blue-50' : 'bg-slate-100'
                    }`}>
                        <User className={`w-16 h-16 ${
                            status === CallStatus.ACTIVE ? 'text-green-600' : 
                            status === CallStatus.DIALING ? 'text-blue-600' : 'text-slate-400'
                        }`} />
                    </div>

                    <h3 className="text-2xl font-bold text-slate-800 mb-1">{currentLead.name}</h3>
                    <p className="text-slate-500 mb-8">{currentLead.city}, India</p>

                    {status === CallStatus.ACTIVE && (
                        <div className="w-full max-w-sm mb-8">
                            <AudioVisualizer stream={micStream} active={true} />
                        </div>
                    )}

                    <div className="flex gap-4">
                        {status === CallStatus.IDLE || status === CallStatus.ENDED ? (
                            <button 
                                onClick={() => startCall(currentLeadIndex!)}
                                className="bg-green-600 hover:bg-green-700 text-white px-8 py-4 rounded-2xl font-bold flex items-center gap-3 shadow-xl shadow-green-200 transition-all active:scale-95 group"
                            >
                                <Phone className="w-6 h-6 group-hover:animate-bounce" />
                                {status === CallStatus.ENDED ? 'Call Again' : 'Connect Now'}
                            </button>
                        ) : (
                            <button 
                                onClick={stopCall}
                                className="bg-red-500 hover:bg-red-600 text-white px-8 py-4 rounded-2xl font-bold flex items-center gap-3 shadow-xl shadow-red-200 transition-all active:scale-95"
                            >
                                <PhoneOff className="w-6 h-6" />
                                End Call
                            </button>
                        )}
                    </div>

                    {status === CallStatus.DIALING && <p className="mt-4 text-blue-600 font-medium animate-pulse">Dialing Customer...</p>}
                </>
            ) : (
                <div className="text-center py-12">
                    <User className="w-16 h-16 text-slate-200 mx-auto mb-4" />
                    <p className="text-slate-500">Select a lead from the queue to start a call</p>
                </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 flex-1">
             {/* Product Config */}
             <section className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
                <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                    <Package className="w-5 h-5 text-green-600" /> Active Pitch Info
                </h2>
                <div className="space-y-3">
                    <div>
                        <label className="text-[10px] uppercase font-bold text-slate-400">Pitch Product</label>
                        <input type="text" value={product.name} onChange={e => setProduct({...product, name: e.target.value})} className="w-full bg-slate-50 border-none p-2 rounded text-sm focus:ring-1 focus:ring-green-500" />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <div>
                            <label className="text-[10px] uppercase font-bold text-slate-400">Price (INR)</label>
                            <input type="text" value={product.price} onChange={e => setProduct({...product, price: e.target.value})} className="w-full bg-slate-50 border-none p-2 rounded text-sm" />
                        </div>
                        <div>
                            <label className="text-[10px] uppercase font-bold text-slate-400">Deal</label>
                            <input type="text" value={product.offer} onChange={e => setProduct({...product, offer: e.target.value})} className="w-full bg-slate-50 border-none p-2 rounded text-sm" />
                        </div>
                    </div>
                </div>
             </section>

             {/* Live Transcript */}
             <section className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 flex flex-col h-[300px]">
                <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                    <MessageSquare className="w-5 h-5 text-green-600" /> Live Conversation
                </h2>
                <div className="flex-1 overflow-y-auto space-y-3 pr-2 text-sm">
                    {transcriptions.length === 0 && <p className="text-slate-400 italic text-center mt-12">No active transcript</p>}
                    {transcriptions.map((t, i) => (
                        <div key={i} className={`flex ${t.role === 'agent' ? 'justify-end' : 'justify-start'}`}>
                            <div className={`p-3 rounded-xl max-w-[85%] ${t.role === 'agent' ? 'bg-green-50 text-green-800' : 'bg-slate-100 text-slate-800'}`}>
                                {t.text}
                            </div>
                        </div>
                    ))}
                </div>
             </section>
          </div>
        </div>
      </main>

      <footer className="mt-12 text-slate-400 text-sm pb-8 text-center max-w-2xl">
        <p>BharatAI automates your outbound calling workflow. Upload PDF lists, call via AI, and export professional reports instantly.</p>
      </footer>
    </div>
  );
};

export default App;
