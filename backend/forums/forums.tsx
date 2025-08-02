import React, {useState} from 'react';

type Post = {
    id: number;
    author: string;
    content: string;
    timestamp: Date;
    tags: string[];
}

const initialPosts: Post[] = [
    {
        id: 1, 
        author: 'Alice', 
        content: 'Hello, world!', 
        timestamp: new Date(), 
        tags: [],
    }
];

const Forums: React.FC = () => {
    const [posts, setPosts] = useState<Post[]>(initialPosts);
    const [author, setAuthor] = useState("");
    const [content, setContent] = useState("");

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!author.trim() || !content.trim()) return;
        const newPost: Post = {
            id: posts.length + 1,
            author,
            content