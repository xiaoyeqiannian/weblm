/**
 * 语音服务模块
 * 支持语音识别和语音合成
 */

class VoiceService {
  constructor() {
    this.recognition = null;
    this.synthesis = window.speechSynthesis;
    this.isListening = false;
    this.isSpeaking = false;
    this.onResult = null;
    this.onError = null;
    this.onStart = null;
    this.onEnd = null;
    this.selectedVoice = null;
    
    this._initRecognition();
  }

  /**
   * 初始化语音识别
   */
  _initRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    
    if (!SpeechRecognition) {
      console.warn('当前浏览器不支持语音识别');
      return;
    }

    this.recognition = new SpeechRecognition();
    this.recognition.continuous = false;
    this.recognition.interimResults = true;
    this.recognition.lang = 'zh-CN';

    this.recognition.onstart = () => {
      this.isListening = true;
      if (this.onStart) this.onStart();
    };

    this.recognition.onend = () => {
      this.isListening = false;
      if (this.onEnd) this.onEnd();
    };

    this.recognition.onresult = (event) => {
      let finalTranscript = '';
      let interimTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript;
        } else {
          interimTranscript += transcript;
        }
      }

      if (this.onResult) {
        this.onResult({
          final: finalTranscript,
          interim: interimTranscript,
          isFinal: finalTranscript.length > 0
        });
      }
    };

    this.recognition.onerror = (event) => {
      console.error('语音识别错误:', event.error);
      this.isListening = false;
      if (this.onError) this.onError(event.error);
    };
  }

  /**
   * 开始语音识别
   */
  startListening() {
    if (!this.recognition) {
      throw new Error('语音识别不可用');
    }

    if (this.isListening) {
      return;
    }

    // 如果正在播放语音，先停止
    if (this.isSpeaking) {
      this.stopSpeaking();
    }

    try {
      this.recognition.start();
    } catch (e) {
      console.error('启动语音识别失败:', e);
    }
  }

  /**
   * 停止语音识别
   */
  stopListening() {
    if (this.recognition && this.isListening) {
      this.recognition.stop();
    }
  }

  /**
   * 切换语音识别状态
   */
  toggleListening() {
    if (this.isListening) {
      this.stopListening();
    } else {
      this.startListening();
    }
    return this.isListening;
  }

  /**
   * 获取可用的语音列表
   */
  getVoices() {
    return new Promise((resolve) => {
      let voices = this.synthesis.getVoices();
      
      if (voices.length > 0) {
        resolve(voices);
        return;
      }

      // 某些浏览器需要等待 voiceschanged 事件
      this.synthesis.onvoiceschanged = () => {
        voices = this.synthesis.getVoices();
        resolve(voices);
      };

      // 超时处理
      setTimeout(() => {
        voices = this.synthesis.getVoices();
        resolve(voices);
      }, 1000);
    });
  }

  /**
   * 设置语音
   */
  async setVoice(voiceName) {
    const voices = await this.getVoices();
    this.selectedVoice = voices.find(v => v.name === voiceName) || null;
  }

  /**
   * 获取中文语音
   */
  async getChineseVoices() {
    const voices = await this.getVoices();
    return voices.filter(v => v.lang.startsWith('zh'));
  }

  /**
   * 语音合成（文字转语音）
   */
  async speak(text, options = {}) {
    if (!this.synthesis) {
      throw new Error('语音合成不可用');
    }

    // 停止之前的语音
    this.stopSpeaking();

    return new Promise(async (resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);
      
      // 设置语音参数
      utterance.rate = options.rate || 1.0;
      utterance.pitch = options.pitch || 1.0;
      utterance.volume = options.volume || 1.0;
      utterance.lang = options.lang || 'zh-CN';

      // 设置语音
      if (this.selectedVoice) {
        utterance.voice = this.selectedVoice;
      } else {
        // 尝试获取中文语音
        const voices = await this.getChineseVoices();
        if (voices.length > 0) {
          utterance.voice = voices[0];
        }
      }

      utterance.onstart = () => {
        this.isSpeaking = true;
      };

      utterance.onend = () => {
        this.isSpeaking = false;
        resolve();
      };

      utterance.onerror = (event) => {
        this.isSpeaking = false;
        reject(event.error);
      };

      this.synthesis.speak(utterance);
    });
  }

  /**
   * 停止语音合成
   */
  stopSpeaking() {
    if (this.synthesis) {
      this.synthesis.cancel();
      this.isSpeaking = false;
    }
  }

  /**
   * 暂停语音合成
   */
  pauseSpeaking() {
    if (this.synthesis) {
      this.synthesis.pause();
    }
  }

  /**
   * 恢复语音合成
   */
  resumeSpeaking() {
    if (this.synthesis) {
      this.synthesis.resume();
    }
  }

  /**
   * 流式语音合成（边生成边播放）
   */
  async speakStream(textStream, options = {}) {
    const { sentenceDelimiters = ['。', '！', '？', '；', '\n', '.', '!', '?'] } = options;
    let buffer = '';
    
    for await (const chunk of textStream) {
      buffer += chunk;
      
      // 检查是否有完整的句子
      for (const delimiter of sentenceDelimiters) {
        const lastIndex = buffer.lastIndexOf(delimiter);
        if (lastIndex !== -1) {
          const sentence = buffer.substring(0, lastIndex + 1);
          buffer = buffer.substring(lastIndex + 1);
          
          if (sentence.trim()) {
            await this.speak(sentence.trim(), options);
          }
          break;
        }
      }
    }
    
    // 播放剩余内容
    if (buffer.trim()) {
      await this.speak(buffer.trim(), options);
    }
  }

  /**
   * 检查语音功能是否可用
   */
  checkAvailability() {
    return {
      recognition: !!this.recognition,
      synthesis: !!this.synthesis
    };
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { VoiceService };
} else {
  window.VoiceService = VoiceService;
}
