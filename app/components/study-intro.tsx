"use client";

import { useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";

type StudyIntroProps = {
  onComplete: () => void;
};

const particles = [
  [8, 18, 0], [17, 73, 1], [28, 28, 2], [36, 82, 3], [51, 12, 4], [62, 78, 5],
  [74, 24, 6], [84, 68, 7], [92, 36, 8], [12, 46, 9], [44, 54, 10], [68, 48, 11],
  [79, 88, 12], [24, 92, 13], [56, 91, 14], [95, 77, 15],
];

export function StudyIntro({ onComplete }: StudyIntroProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<gsap.core.Timeline | null>(null);

  useGSAP((_, contextSafe) => {
    const root = rootRef.current;
    if (!root) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const compact = window.matchMedia("(max-width: 720px)").matches;
    const speed = reduceMotion ? 0 : compact ? 0.78 : 1;
    const complete = contextSafe(() => onComplete());
    const tl = gsap.timeline({
      paused: true,
      defaults: { ease: "power3.out" },
      onComplete: complete,
    });

    timelineRef.current = tl;
    tl.set(root, { autoAlpha: 1 })
      .from(".intro-grid", { autoAlpha: 0, duration: 0.55 * speed }, 0)
      .from(".intro-halo", { scale: 0.35, autoAlpha: 0, duration: 1.05 * speed, ease: "power2.out" }, 0)
      .from(".intro-orbit", { scale: 0.2, rotation: -42, autoAlpha: 0, duration: 1.1 * speed, ease: "back.out(1.45)" }, 0.12)
      .from(".intro-orbit-ring", { scale: 0.55, rotation: 32, autoAlpha: 0, duration: 0.8 * speed, stagger: 0.08 * speed, ease: "back.out(1.8)" }, 0.16)
      .from(".intro-crosshair", { scaleX: 0, scaleY: 0, autoAlpha: 0, duration: 0.7 * speed, stagger: 0.1 * speed }, 0.24)
      .from(".intro-scanline", { scaleX: 0, autoAlpha: 0, duration: 0.8 * speed, ease: "power4.inOut" }, 0.3)
      .from(".intro-particle", { scale: 0, autoAlpha: 0, duration: 0.42 * speed, stagger: { each: 0.035 * speed, from: "random" }, ease: "back.out(2)" }, 0.28)
      .from(".intro-node", { scale: 0.5, y: 52, autoAlpha: 0, duration: 0.62 * speed, stagger: 0.13 * speed, ease: "back.out(1.7)" }, 0.62)
      .from(".intro-core", { scale: 0.2, rotation: -20, autoAlpha: 0, duration: 0.9 * speed, ease: "elastic.out(1, 0.45)" }, 0.52)
      .from(".intro-wordmark", { y: 22, autoAlpha: 0, duration: 0.62 * speed }, 1.05)
      .from(".intro-subline", { y: 12, autoAlpha: 0, duration: 0.5 * speed }, "<0.12")
      .to(".intro-progress-fill", { scaleX: 1, duration: 0.9 * speed, ease: "power2.inOut" }, 1.16)
      .to(".intro-signal", { scale: 1.28, autoAlpha: 0, duration: 0.62 * speed, ease: "power2.out" }, 1.94)
      .to(".intro-content", { scale: 1.06, autoAlpha: 0, duration: 0.58 * speed, ease: "power3.in" }, 2.06)
      .to(root, { yPercent: -100, duration: 0.72 * speed, ease: "power4.inOut" }, 2.16);

    if (reduceMotion) {
      tl.progress(1);
    } else {
      gsap.to(".intro-orbit", { rotation: "+=360", duration: 18, repeat: -1, ease: "none" });
      gsap.to(".intro-particle", { y: -8, x: 4, duration: 2.4, repeat: -1, yoyo: true, stagger: { each: 0.08, from: "random" }, ease: "sine.inOut" });
      tl.play();
    }

    return () => {
      tl.kill();
      timelineRef.current = null;
    };
  }, { scope: rootRef });

  const skipIntro = () => {
    timelineRef.current?.progress(1);
  };

  return (
    <div ref={rootRef} className="study-intro" role="dialog" aria-label="学习管家正在启动" aria-modal="true">
      <div className="intro-grid" aria-hidden="true" />
      <div className="intro-noise" aria-hidden="true" />
      <div className="intro-content">
        <div className="intro-meta"><span>STUDY OS / 01</span><span>LOCAL-FIRST SYSTEM</span></div>
        <div className="intro-stage">
          <div className="intro-halo" aria-hidden="true" />
          <div className="intro-signal" aria-hidden="true" />
          <div className="intro-orbit" aria-hidden="true">
            <span className="intro-orbit-ring ring-one" />
            <span className="intro-orbit-ring ring-two" />
            <span className="intro-orbit-ring ring-three" />
            <span className="intro-crosshair crosshair-x" />
            <span className="intro-crosshair crosshair-y" />
          </div>
          <div className="intro-scanline" aria-hidden="true" />
          {particles.map(([left, top, index]) => (
            <span
              className="intro-particle"
              key={`${left}-${top}`}
              style={{ left: `${left}%`, top: `${top}%`, ["--particle-index" as string]: index }}
              aria-hidden="true"
            />
          ))}
          <div className="intro-node node-resource"><span>01</span><b>资料入库</b><small>ORGANIZE</small></div>
          <div className="intro-node node-deadline"><span>02</span><b>DDL 提醒</b><small>REMEMBER</small></div>
          <div className="intro-node node-review"><span>03</span><b>复习计划</b><small>REVIEW</small></div>
          <div className="intro-core"><span>学</span><i /></div>
        </div>
        <div className="intro-wordmark"><span className="intro-kicker">PERSONAL STUDY DESK</span><strong>学习管家</strong></div>
        <p className="intro-subline">把分散的信息，变成下一步。</p>
        <div className="intro-progress" aria-hidden="true"><span className="intro-progress-fill" /></div>
      </div>
      <button className="intro-skip" onClick={skipIntro}>跳过片头 <span>↗</span></button>
    </div>
  );
}
